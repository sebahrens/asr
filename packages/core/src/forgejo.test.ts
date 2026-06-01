import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { ForgejoClient, ForgejoConflictError, type ForgejoConfig } from './forgejo.js';
import type { SkillManifest } from './types.js';

interface ForgejoClientInternals {
  cfg: ForgejoConfig;
  upload: Octokit;
  merge: Octokit;
  createOrGetBranch(branch: string): Promise<string>;
  putFile(branch: string, path: string, content: Buffer, submissionId: string): Promise<string>;
}

const internals = (client: ForgejoClient): ForgejoClientInternals =>
  client as unknown as ForgejoClientInternals;

const octokitBaseUrl = (client: Octokit): string => client.request.endpoint.DEFAULTS.baseUrl;

const cfg: ForgejoConfig = {
  baseUrl: 'https://forgejo.example.test/api/v1',
  uploadToken: 'upload-token',
  mergeToken: 'merge-token',
  owner: 'asr',
  repo: 'skills',
  defaultBranch: 'main',
};

describe('ForgejoClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs distinct upload and merge Octokit clients with the configured baseUrl', () => {
    const client = internals(new ForgejoClient(cfg));

    expect(client.cfg).toBe(cfg);
    expect(client.upload).toBeInstanceOf(Octokit);
    expect(client.merge).toBeInstanceOf(Octokit);
    expect(client.upload).not.toBe(client.merge);
    expect(octokitBaseUrl(client.upload)).toBe(cfg.baseUrl);
    expect(octokitBaseUrl(client.merge)).toBe(cfg.baseUrl);
  });

  it('creates a submission branch from the configured default branch', async () => {
    const client = internals(new ForgejoClient(cfg));
    const uploadRequest = vi.spyOn(client.upload, 'request').mockResolvedValueOnce({
      data: { commit: { id: 'created-head-sha' } },
    } as never);

    await expect(client.createOrGetBranch('submit/sub-1')).resolves.toBe('created-head-sha');

    expect(uploadRequest).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/branches', {
      owner: 'asr',
      repo: 'skills',
      new_branch_name: 'submit/sub-1',
      old_branch_name: 'main',
    });
  });

  it('fetches the branch head sha when submission branch creation conflicts', async () => {
    const client = internals(new ForgejoClient(cfg));
    const uploadRequest = vi
      .spyOn(client.upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { commit: { id: 'existing-head-sha' } } } as never);

    await expect(client.createOrGetBranch('submit/sub-1')).resolves.toBe('existing-head-sha');

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'POST /repos/{owner}/{repo}/branches', {
      owner: 'asr',
      repo: 'skills',
      new_branch_name: 'submit/sub-1',
      old_branch_name: 'main',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(
      2,
      'GET /repos/{owner}/{repo}/branches/{branch}',
      {
        owner: 'asr',
        repo: 'skills',
        branch: 'submit/sub-1',
      },
    );
  });

  it('protects the default branch with the merge token and Forgejo whitelist fields', async () => {
    const rawClient = new ForgejoClient(cfg);
    const client = internals(rawClient);
    const mergeRequest = vi
      .spyOn(client.merge, 'request')
      .mockResolvedValueOnce({ data: {} } as never);

    await expect(
      rawClient.protectDefaultBranch({
        mergeWhitelistUsernames: ['asr-merge-bot'],
      }),
    ).resolves.toBeUndefined();

    expect(mergeRequest).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/branch_protections', {
      owner: 'asr',
      repo: 'skills',
      branch_name: 'main',
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: [],
      enable_merge_whitelist: true,
      merge_whitelist_usernames: ['asr-merge-bot'],
      enable_status_check: true,
      status_check_contexts: ['validate-submission'],
      required_approvals: 1,
      block_on_rejected_reviews: true,
      block_on_outdated_branch: true,
      dismiss_stale_approvals: true,
      enable_force_push: false,
      enable_push_keys: false,
    });
  });

  it('updates existing branch protection when bootstrap is re-run', async () => {
    const rawClient = new ForgejoClient(cfg);
    const client = internals(rawClient);
    const mergeRequest = vi
      .spyOn(client.merge, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: {} } as never);

    await expect(
      rawClient.protectDefaultBranch({
        mergeWhitelistUsernames: ['asr-merge-bot'],
        statusCheckContexts: ['validate-submission', 'scanner'],
        requiredApprovals: 2,
      }),
    ).resolves.toBeUndefined();

    expect(mergeRequest).toHaveBeenNthCalledWith(
      2,
      'PATCH /repos/{owner}/{repo}/branch_protections/{name}',
      {
        owner: 'asr',
        repo: 'skills',
        name: 'main',
        branch_name: 'main',
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_usernames: [],
        enable_merge_whitelist: true,
        merge_whitelist_usernames: ['asr-merge-bot'],
        enable_status_check: true,
        status_check_contexts: ['validate-submission', 'scanner'],
        required_approvals: 2,
        block_on_rejected_reviews: true,
        block_on_outdated_branch: true,
        dismiss_stale_approvals: true,
        enable_force_push: false,
        enable_push_keys: false,
      },
    );
  });

  it('puts file content on the submission branch with a deterministic commit message', async () => {
    const client = internals(new ForgejoClient(cfg));
    const uploadRequest = vi.spyOn(client.upload, 'request').mockResolvedValueOnce({
      data: { commit: { sha: 'file-commit-sha' } },
    } as never);

    await expect(
      client.putFile('submit/sub-1', 'skills/acme/demo/SKILL.md', Buffer.from('skill'), 'sub-1'),
    ).resolves.toBe('file-commit-sha');

    expect(uploadRequest).toHaveBeenCalledWith('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/demo/SKILL.md',
      message: 'submit: skills/acme/demo/SKILL.md (sub-1)',
      content: Buffer.from('skill').toString('base64'),
      branch: 'submit/sub-1',
    });
  });

  it('returns the existing file commit sha when putting identical content conflicts', async () => {
    const client = internals(new ForgejoClient(cfg));
    const content = Buffer.from('skill');
    const uploadRequest = vi
      .spyOn(client.upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({
        data: {
          content: content.toString('base64'),
          encoding: 'base64',
          last_commit_sha: 'existing-file-commit-sha',
        },
      } as never);

    await expect(
      client.putFile('submit/sub-1', 'skills/acme/demo/SKILL.md', content, 'sub-1'),
    ).resolves.toBe('existing-file-commit-sha');

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/demo/SKILL.md',
      message: 'submit: skills/acme/demo/SKILL.md (sub-1)',
      content: content.toString('base64'),
      branch: 'submit/sub-1',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(
      2,
      'GET /repos/{owner}/{repo}/contents/{path}',
      {
        owner: 'asr',
        repo: 'skills',
        path: 'skills/acme/demo/SKILL.md',
        ref: 'submit/sub-1',
      },
    );
  });

  it('throws ForgejoConflictError when a put conflict finds different existing content', async () => {
    const client = internals(new ForgejoClient(cfg));
    vi.spyOn(client.upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('other').toString('base64'),
          encoding: 'base64',
          last_commit_sha: 'existing-file-commit-sha',
        },
      } as never);

    const result = client.putFile(
      'submit/sub-1',
      'skills/acme/demo/SKILL.md',
      Buffer.from('skill'),
      'sub-1',
    );

    await expect(result).rejects.toMatchObject({
      name: 'ForgejoConflictError',
      branch: 'submit/sub-1',
      path: 'skills/acme/demo/SKILL.md',
    });
    await expect(result).rejects.toBeInstanceOf(ForgejoConflictError);
  });

  it('opens a submission PR after sequentially committing files and polling mergeability', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { commit: { id: 'branch-head-sha' } } } as never)
      .mockResolvedValueOnce({ data: { commit: { sha: 'skill-md-sha' } } } as never)
      .mockResolvedValueOnce({ data: { commit: { sha: 'readme-sha' } } } as never)
      .mockResolvedValueOnce({ data: { number: 37 } } as never)
      .mockResolvedValueOnce({ data: { number: 37, mergeable: true } } as never);

    const manifest: SkillManifest = {
      name: 'agent-skill',
      version: '1.2.3',
      author: 'acme',
      description: 'Demo skill.',
      tags: ['demo'],
      kind: 'persona',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    };

    await expect(
      client.openSubmissionPR({
        submissionId: 'sub-1',
        manifest,
        files: [
          { path: 'SKILL.md', content: Buffer.from('skill') },
          { path: 'README.md', content: Buffer.from('readme') },
        ],
        autoApprove: true,
      }),
    ).resolves.toEqual({
      branch: 'submit/sub-1',
      prNumber: 37,
      headSha: 'readme-sha',
    });

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'POST /repos/{owner}/{repo}/branches', {
      owner: 'asr',
      repo: 'skills',
      new_branch_name: 'submit/sub-1',
      old_branch_name: 'main',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(2, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/agent-skill/SKILL.md',
      message: 'submit: skills/acme/agent-skill/SKILL.md (sub-1)',
      content: Buffer.from('skill').toString('base64'),
      branch: 'submit/sub-1',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/agent-skill/README.md',
      message: 'submit: skills/acme/agent-skill/README.md (sub-1)',
      content: Buffer.from('readme').toString('base64'),
      branch: 'submit/sub-1',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(4, 'POST /repos/{owner}/{repo}/pulls', {
      owner: 'asr',
      repo: 'skills',
      title: '[Skill] agent-skill@1.2.3',
      head: 'submit/sub-1',
      base: 'main',
      body: [
        'Submission: sub-1',
        'Skill: agent-skill@1.2.3',
        'Author: acme',
        'Review path: auto-approve',
      ].join('\n'),
      labels: ['auto-approve'],
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(5, 'GET /repos/{owner}/{repo}/pulls/{index}', {
      owner: 'asr',
      repo: 'skills',
      index: 37,
    });
  });

  it('returns the existing file commit as headSha when openSubmissionPR hits an idempotent put conflict', async () => {
    const client = new ForgejoClient(cfg);
    const content = Buffer.from('skill');
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { commit: { id: 'branch-head-sha' } } } as never)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({
        data: {
          content: content.toString('base64'),
          encoding: 'base64',
          last_commit_sha: 'existing-file-commit-sha',
        },
      } as never)
      .mockResolvedValueOnce({ data: { number: 37 } } as never)
      .mockResolvedValueOnce({ data: { number: 37, mergeable: true } } as never);

    await expect(
      client.openSubmissionPR({
        submissionId: 'sub-1',
        manifest: {
          name: 'agent-skill',
          version: '1.2.3',
          author: 'acme',
          description: 'Demo skill.',
          tags: ['demo'],
          kind: 'persona',
          permissions: {
            network: false,
            filesystem: 'read-own',
            subprocess: false,
            environment: [],
          },
        },
        files: [{ path: 'SKILL.md', content }],
        autoApprove: true,
      }),
    ).resolves.toEqual({
      branch: 'submit/sub-1',
      prNumber: 37,
      headSha: 'existing-file-commit-sha',
    });

    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/agent-skill/SKILL.md',
      ref: 'submit/sub-1',
    });
  });

  it('refuses unsafe manifest-derived repository paths before creating a submission branch', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi.spyOn(internals(client).upload, 'request');

    await expect(
      client.openSubmissionPR({
        submissionId: 'sub-1',
        manifest: {
          name: '..',
          version: '1.2.3',
          author: 'acme',
          description: 'Demo skill.',
          tags: ['demo'],
          kind: 'skill',
          permissions: {
            network: false,
            filesystem: 'read-own',
            subprocess: false,
            environment: [],
          },
        },
        files: [{ path: 'SKILL.md', content: Buffer.from('skill') }],
        autoApprove: true,
      }),
    ).rejects.toThrow(/invalid skill name/);

    expect(uploadRequest).not.toHaveBeenCalled();
  });

  it('refuses file paths containing parent-directory segments', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi.spyOn(internals(client).upload, 'request');

    await expect(
      client.openSubmissionPR({
        submissionId: 'sub-1',
        manifest: {
          name: 'agent-skill',
          version: '1.2.3',
          author: 'acme',
          description: 'Demo skill.',
          tags: ['demo'],
          kind: 'skill',
          permissions: {
            network: false,
            filesystem: 'read-own',
            subprocess: false,
            environment: [],
          },
        },
        files: [{ path: '../other/SKILL.md', content: Buffer.from('skill') }],
        autoApprove: true,
      }),
    ).rejects.toThrow(/unsafe repository path/);

    expect(uploadRequest).not.toHaveBeenCalled();
  });

  it('opens a PR with custom branch, root path, and PR metadata overrides', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { commit: { id: 'branch-head-sha' } } } as never)
      .mockResolvedValueOnce({ data: { commit: { sha: 'marketplace-sha' } } } as never)
      .mockResolvedValueOnce({ data: { number: 38 } } as never)
      .mockResolvedValueOnce({ data: { number: 38, mergeable: true } } as never);

    const manifest: SkillManifest = {
      name: 'skill-marketplace',
      version: '1',
      author: 'asr',
      description: 'Generated marketplace sync.',
      tags: ['marketplace'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'none',
        subprocess: false,
        environment: [],
      },
    };

    await client.openSubmissionPR({
      submissionId: 'marketplace-sync-1',
      manifest,
      branch: 'marketplace-sync/1',
      pathPrefix: '',
      title: '[Marketplace] Sync',
      body: 'Generated marketplace sync.',
      labels: ['auto-approve', 'marketplace-sync'],
      files: [{ path: 'marketplace.json', content: Buffer.from('{}\n') }],
      autoApprove: true,
    });

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'POST /repos/{owner}/{repo}/branches', {
      owner: 'asr',
      repo: 'skills',
      new_branch_name: 'marketplace-sync/1',
      old_branch_name: 'main',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(2, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'marketplace.json',
      message: 'submit: marketplace.json (marketplace-sync-1)',
      content: Buffer.from('{}\n').toString('base64'),
      branch: 'marketplace-sync/1',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'POST /repos/{owner}/{repo}/pulls', {
      owner: 'asr',
      repo: 'skills',
      title: '[Marketplace] Sync',
      head: 'marketplace-sync/1',
      base: 'main',
      body: 'Generated marketplace sync.',
      labels: ['auto-approve', 'marketplace-sync'],
    });
  });

  it('reuses an existing PR for idempotent submission branches', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({
        data: [{ number: 38, head: { ref: 'marketplace-sync/hash' } }],
      } as never)
      .mockResolvedValueOnce({ data: { commit: { id: 'existing-head-sha' } } } as never);

    await expect(
      client.openSubmissionPR({
        submissionId: 'marketplace-sync-hash',
        manifest: {
          name: 'skill-marketplace',
          version: '1',
          author: 'asr',
          description: 'Generated marketplace sync.',
          tags: ['marketplace'],
          kind: 'skill',
          permissions: {
            network: false,
            filesystem: 'none',
            subprocess: false,
            environment: [],
          },
        },
        branch: 'marketplace-sync/hash',
        pathPrefix: '',
        files: [{ path: 'marketplace.json', content: Buffer.from('{}\n') }],
        autoApprove: true,
        idempotent: true,
      }),
    ).resolves.toEqual({
      branch: 'marketplace-sync/hash',
      prNumber: 38,
      headSha: 'existing-head-sha',
    });

    expect(uploadRequest).toHaveBeenCalledTimes(2);
    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'GET /repos/{owner}/{repo}/pulls', {
      owner: 'asr',
      repo: 'skills',
      state: 'all',
      per_page: 50,
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: 'asr',
      repo: 'skills',
      branch: 'marketplace-sync/hash',
    });
  });

  it('uploads a generic package artifact with the upload token', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetch);

    const zipBuffer = Buffer.from('zip-content');
    const url = await new ForgejoClient(cfg).publishArtifact({
      owner: 'acme',
      name: 'agent-skill',
      version: '1.2.3',
      zipBuffer,
    });

    expect(url).toBe(
      'https://forgejo.example.test/api/packages/acme/generic/agent-skill/1.2.3/skill.zip',
    );
    expect(fetch).toHaveBeenCalledWith(url, {
      method: 'PUT',
      headers: {
        Authorization: 'token upload-token',
        'Content-Type': 'application/zip',
      },
      body: zipBuffer,
    });
  });

  it('merges a PR with the merge token client and returns the merge commit sha', async () => {
    const client = new ForgejoClient(cfg);
    const { upload, merge } = internals(client);
    const uploadRequest = vi.spyOn(upload, 'request');
    const mergeRequest = vi
      .spyOn(merge, 'request')
      .mockResolvedValueOnce({ data: {} } as never)
      .mockResolvedValueOnce({ data: { merge_commit_sha: 'merge-sha' } } as never);

    await expect(client.mergePR(42)).resolves.toEqual({ sha: 'merge-sha' });

    expect(uploadRequest).not.toHaveBeenCalled();
    expect(mergeRequest).toHaveBeenNthCalledWith(
      1,
      'POST /repos/{owner}/{repo}/pulls/{index}/merge',
      {
        owner: 'asr',
        repo: 'skills',
        index: 42,
        Do: 'squash',
        merge_message_field: 'Approved and published (#42)',
        delete_branch_after_merge: true,
      },
    );
    expect(mergeRequest).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/pulls/{index}', {
      owner: 'asr',
      repo: 'skills',
      index: 42,
    });
  });

  it('tolerates already-merged PRs and returns the existing merge commit sha', async () => {
    const client = new ForgejoClient(cfg);
    const mergeRequest = vi
      .spyOn(internals(client).merge, 'request')
      .mockRejectedValueOnce({ status: 405 })
      .mockResolvedValueOnce({ data: { merge_commit_sha: 'existing-merge-sha' } } as never);

    await expect(client.mergePR(7)).resolves.toEqual({ sha: 'existing-merge-sha' });

    expect(mergeRequest).toHaveBeenCalledTimes(2);
  });

  it('commits a marker file to main via branch, PR, merge, and branch cleanup', async () => {
    const client = new ForgejoClient(cfg);
    const { upload, merge } = internals(client);
    const uploadRequest = vi
      .spyOn(upload, 'request')
      .mockResolvedValueOnce({ data: { commit: { id: 'marker-branch-sha' } } } as never)
      .mockResolvedValueOnce({ data: { commit: { sha: 'marker-put-sha' } } } as never)
      .mockResolvedValueOnce({ data: { number: 99 } } as never)
      .mockResolvedValueOnce({ data: { number: 99, mergeable: true } } as never);
    const mergeRequest = vi
      .spyOn(merge, 'request')
      .mockResolvedValueOnce({ data: {} } as never)
      .mockResolvedValueOnce({ data: { merge_commit_sha: 'marker-merge-sha' } } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    await expect(
      client.commitFileToMain({
        owner: 'acme',
        name: 'x',
        path: 'skills/acme/x/YANKED.md',
        content: Buffer.from('yanked'),
        message: 'yank x@1.0.0',
        idempotencyKey: 'yank-x-1.0.0',
      }),
    ).resolves.toEqual({ sha: 'marker-merge-sha' });

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'POST /repos/{owner}/{repo}/branches', {
      owner: 'asr',
      repo: 'skills',
      new_branch_name: 'marker/yank-x-1.0.0',
      old_branch_name: 'main',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(2, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/x/YANKED.md',
      message: 'submit: skills/acme/x/YANKED.md (yank-x-1.0.0)',
      content: Buffer.from('yanked').toString('base64'),
      branch: 'marker/yank-x-1.0.0',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'POST /repos/{owner}/{repo}/pulls', {
      owner: 'asr',
      repo: 'skills',
      title: 'yank x@1.0.0',
      head: 'marker/yank-x-1.0.0',
      base: 'main',
      body: ['yank x@1.0.0', 'Skill: acme/x', 'File: skills/acme/x/YANKED.md'].join('\n'),
      labels: ['marker'],
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(4, 'GET /repos/{owner}/{repo}/pulls/{index}', {
      owner: 'asr',
      repo: 'skills',
      index: 99,
    });
    expect(mergeRequest).toHaveBeenNthCalledWith(
      1,
      'POST /repos/{owner}/{repo}/pulls/{index}/merge',
      {
        owner: 'asr',
        repo: 'skills',
        index: 99,
        Do: 'squash',
        merge_message_field: 'Approved and published (#99)',
        delete_branch_after_merge: true,
      },
    );
    expect(mergeRequest).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/pulls/{index}', {
      owner: 'asr',
      repo: 'skills',
      index: 99,
    });
    expect(mergeRequest).toHaveBeenNthCalledWith(
      3,
      'DELETE /repos/{owner}/{repo}/branches/{branch}',
      {
        owner: 'asr',
        repo: 'skills',
        branch: 'marker/yank-x-1.0.0',
      },
    );
  });

  it('tolerates idempotent retries of commitFileToMain (409 branch, 409 put, 405 merge)', async () => {
    const client = new ForgejoClient(cfg);
    const { upload, merge } = internals(client);
    vi.spyOn(upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { commit: { id: 'existing-branch-sha' } } } as never)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('yanked').toString('base64'),
          encoding: 'base64',
          last_commit_sha: 'existing-put-sha',
        },
      } as never)
      .mockResolvedValueOnce({ data: { number: 100 } } as never)
      .mockResolvedValueOnce({ data: { number: 100, mergeable: true } } as never);
    vi.spyOn(merge, 'request')
      .mockRejectedValueOnce({ status: 405 })
      .mockResolvedValueOnce({ data: { merge_commit_sha: 'retry-merge-sha' } } as never)
      .mockRejectedValueOnce({ status: 404 });

    await expect(
      client.commitFileToMain({
        owner: 'acme',
        name: 'x',
        path: 'skills/acme/x/YANKED.md',
        content: Buffer.from('yanked'),
        message: 'yank x@1.0.0',
        idempotencyKey: 'yank-x-1.0.0',
      }),
    ).resolves.toEqual({ sha: 'retry-merge-sha' });
  });

  it('deletes branches with the merge token client and tolerates missing branches', async () => {
    const client = new ForgejoClient(cfg);
    const { upload, merge } = internals(client);
    const uploadRequest = vi.spyOn(upload, 'request');
    const mergeRequest = vi
      .spyOn(merge, 'request')
      .mockResolvedValueOnce({ data: {} } as never)
      .mockRejectedValueOnce({ status: 404 });

    await expect(client.deleteBranch('submit/skill')).resolves.toBeUndefined();
    await expect(client.deleteBranch('submit/missing')).resolves.toBeUndefined();

    expect(uploadRequest).not.toHaveBeenCalled();
    expect(mergeRequest).toHaveBeenNthCalledWith(
      1,
      'DELETE /repos/{owner}/{repo}/branches/{branch}',
      {
        owner: 'asr',
        repo: 'skills',
        branch: 'submit/skill',
      },
    );
    expect(mergeRequest).toHaveBeenNthCalledWith(
      2,
      'DELETE /repos/{owner}/{repo}/branches/{branch}',
      {
        owner: 'asr',
        repo: 'skills',
        branch: 'submit/missing',
      },
    );
  });

  it('reads the configured default branch head sha via the upload client', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi.spyOn(internals(client).upload, 'request').mockResolvedValueOnce({
      data: { commit: { id: 'main-head-sha' } },
    } as never);

    await expect(client.getDefaultBranchHeadSha()).resolves.toBe('main-head-sha');

    expect(uploadRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: 'asr',
      repo: 'skills',
      branch: 'main',
    });
  });

  it('falls back to "main" when no defaultBranch is configured for getDefaultBranchHeadSha', async () => {
    const client = new ForgejoClient({ ...cfg, defaultBranch: undefined });
    const uploadRequest = vi.spyOn(internals(client).upload, 'request').mockResolvedValueOnce({
      data: { commit: { id: 'fallback-head-sha' } },
    } as never);

    await expect(client.getDefaultBranchHeadSha()).resolves.toBe('fallback-head-sha');

    expect(uploadRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: 'asr',
      repo: 'skills',
      branch: 'main',
    });
  });

  it('creates an annotated tag and its ref via the upload client', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { sha: 'tag-object-sha' } } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    await expect(
      client.createAnchorTag({
        tag: 'audit-anchor-20260101T000000Z',
        message: 'lastHash=ab eventCount=3',
        targetSha: 'abc',
      }),
    ).resolves.toEqual({
      tagName: 'audit-anchor-20260101T000000Z',
      commitSha: 'abc',
    });

    expect(uploadRequest).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = uploadRequest.mock.calls;
    expect(firstCall[0]).toBe('POST /repos/{owner}/{repo}/git/tags');
    expect(firstCall[1]).toMatchObject({
      owner: 'asr',
      repo: 'skills',
      tag: 'audit-anchor-20260101T000000Z',
      message: 'lastHash=ab eventCount=3',
      object: 'abc',
      type: 'commit',
    });
    const taggerArg = (firstCall[1] as { tagger: { name: string; email: string; date: string } })
      .tagger;
    expect(taggerArg.name).toBe('asr-audit-anchor');
    expect(taggerArg.email).toBe('audit@asr.local');
    expect(typeof taggerArg.date).toBe('string');
    expect(secondCall[0]).toBe('POST /repos/{owner}/{repo}/git/refs');
    expect(secondCall[1]).toEqual({
      owner: 'asr',
      repo: 'skills',
      ref: 'refs/tags/audit-anchor-20260101T000000Z',
      sha: 'tag-object-sha',
    });
  });

  it('embeds the GPG signature into the tag message body when provided', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { sha: 'signed-tag-sha' } } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const signature = '-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----';
    await expect(
      client.createAnchorTag({
        tag: 'audit-anchor-20260101T000100Z',
        message: 'lastHash=cd eventCount=4',
        targetSha: 'def',
        signature,
      }),
    ).resolves.toEqual({
      tagName: 'audit-anchor-20260101T000100Z',
      commitSha: 'def',
    });

    const [firstCall] = uploadRequest.mock.calls;
    expect((firstCall[1] as { message: string }).message).toBe(
      `lastHash=cd eventCount=4\n\n${signature}`,
    );
  });

  it('treats an existing identical anchor tag as success when tag creation conflicts', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { object: { sha: 'existing-tag-object-sha' } } } as never)
      .mockResolvedValueOnce({
        data: {
          message: 'lastHash=ab eventCount=3',
          object: { sha: 'abc', type: 'commit' },
        },
      } as never);

    await expect(
      client.createAnchorTag({
        tag: 'audit-anchor-ab-3',
        message: 'lastHash=ab eventCount=3',
        targetSha: 'abc',
      }),
    ).resolves.toEqual({
      tagName: 'audit-anchor-ab-3',
      commitSha: 'abc',
    });

    expect(uploadRequest).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/git/refs/{ref}', {
      owner: 'asr',
      repo: 'skills',
      ref: 'tags/audit-anchor-ab-3',
    });
    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'GET /repos/{owner}/{repo}/git/tags/{sha}', {
      owner: 'asr',
      repo: 'skills',
      sha: 'existing-tag-object-sha',
    });
  });

  it('treats an existing identical anchor ref as success when ref creation conflicts', async () => {
    const client = new ForgejoClient(cfg);
    const uploadRequest = vi
      .spyOn(internals(client).upload, 'request')
      .mockResolvedValueOnce({ data: { sha: 'tag-object-sha' } } as never)
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { object: { sha: 'tag-object-sha' } } } as never);

    await expect(
      client.createAnchorTag({
        tag: 'audit-anchor-cd-4',
        message: 'lastHash=cd eventCount=4',
        targetSha: 'def',
      }),
    ).resolves.toEqual({
      tagName: 'audit-anchor-cd-4',
      commitSha: 'def',
    });

    expect(uploadRequest).toHaveBeenNthCalledWith(3, 'GET /repos/{owner}/{repo}/git/refs/{ref}', {
      owner: 'asr',
      repo: 'skills',
      ref: 'tags/audit-anchor-cd-4',
    });
  });

  it('returns the artifact url when the package already exists', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      new ForgejoClient(cfg).publishArtifact({
        owner: 'acme',
        name: 'agent-skill',
        version: '1.2.3',
        zipBuffer: Buffer.from('zip-content'),
      }),
    ).resolves.toBe(
      'https://forgejo.example.test/api/packages/acme/generic/agent-skill/1.2.3/skill.zip',
    );
  });
});
