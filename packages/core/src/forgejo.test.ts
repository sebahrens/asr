import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { ForgejoClient, type ForgejoConfig } from './forgejo.js';

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

  it('returns the current branch head sha when putting a file conflicts', async () => {
    const client = internals(new ForgejoClient(cfg));
    const uploadRequest = vi
      .spyOn(client.upload, 'request')
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce({ data: { commit: { id: 'current-head-sha' } } } as never);

    await expect(
      client.putFile('submit/sub-1', 'skills/acme/demo/SKILL.md', Buffer.from('skill'), 'sub-1'),
    ).resolves.toBe('current-head-sha');

    expect(uploadRequest).toHaveBeenNthCalledWith(1, 'PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'asr',
      repo: 'skills',
      path: 'skills/acme/demo/SKILL.md',
      message: 'submit: skills/acme/demo/SKILL.md (sub-1)',
      content: Buffer.from('skill').toString('base64'),
      branch: 'submit/sub-1',
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
