import { Octokit } from '@octokit/rest';
import type { Buffer as NodeBuffer } from 'node:buffer';
import { isValidSkillIdentifier } from './identifiers.js';
import type { SkillManifest } from './types.js';

export interface ForgejoConfig {
  baseUrl: string;
  uploadToken: string;
  mergeToken: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
}

interface ForgejoBranchResponse {
  commit: {
    id: string;
  };
}

interface ForgejoContentsPutResponse {
  commit: {
    sha: string;
  };
}

interface ForgejoContentGetResponse {
  content?: string;
  encoding?: string;
  last_commit_sha?: string;
  commit?: {
    id?: string;
    sha?: string;
  };
}

interface ForgejoPullResponse {
  number: number;
  mergeable?: boolean | null;
  head?: {
    ref?: string;
  };
}

interface ForgejoGitTagResponse {
  sha: string;
  message?: string;
  object?: {
    sha?: string;
    type?: string;
  };
}

interface ForgejoGitRefResponse {
  object: {
    sha: string;
    type?: string;
  };
}

export class ForgejoClient {
  private readonly cfg: ForgejoConfig;
  private readonly upload: Octokit;
  private readonly merge: Octokit;

  constructor(cfg: ForgejoConfig) {
    this.cfg = cfg;
    this.upload = new Octokit({ baseUrl: cfg.baseUrl, auth: cfg.uploadToken });
    this.merge = new Octokit({ baseUrl: cfg.baseUrl, auth: cfg.mergeToken });
  }

  private async createOrGetBranch(branch: string): Promise<string> {
    const { owner, repo } = this.cfg;

    try {
      const { data } = await this.upload.request('POST /repos/{owner}/{repo}/branches', {
        owner,
        repo,
        new_branch_name: branch,
        old_branch_name: this.cfg.defaultBranch ?? 'main',
      });

      return forgejoBranchHeadSha(data);
    } catch (err) {
      if (!isOctokitStatus(err, 409)) {
        throw err;
      }
    }

    return this.getBranchHeadSha(branch);
  }

  private async assertExistingFileContent(
    branch: string,
    path: string,
    content: NodeBuffer,
  ): Promise<string> {
    const existing = await this.getFileContent(branch, path);
    if (!existing.content.equals(content)) {
      throw new ForgejoConflictError(
        `repository file already exists with different content: ${path}`,
        { branch, path },
      );
    }

    return existing.commitSha;
  }

  private async getFileContent(
    branch: string,
    path: string,
  ): Promise<{ content: NodeBuffer; commitSha: string }> {
    const { owner, repo } = this.cfg;
    const { data } = await this.upload.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
      ref: branch,
    });
    const file = forgejoFileContent(data);

    return {
      content: decodeForgejoFileContent(file),
      commitSha: forgejoFileLastCommitSha(file),
    };
  }

  private async putFile(
    branch: string,
    path: string,
    content: NodeBuffer,
    submissionId: string,
  ): Promise<string> {
    const { owner, repo } = this.cfg;

    try {
      const { data } = await this.upload.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        message: `submit: ${path} (${submissionId})`,
        content: content.toString('base64'),
        branch,
      });

      return forgejoFileCommitSha(data);
    } catch (err) {
      if (!isOctokitStatus(err, 409)) {
        throw err;
      }
    }

    return this.assertExistingFileContent(branch, path, content);
  }

  private async getBranchHeadSha(branch: string): Promise<string> {
    const { owner, repo } = this.cfg;
    const { data } = await this.upload.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner,
      repo,
      branch,
    });

    return forgejoBranchHeadSha(data);
  }

  async getDefaultBranchHeadSha(): Promise<string> {
    return this.getBranchHeadSha(this.cfg.defaultBranch ?? 'main');
  }

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: NodeBuffer }>;
    autoApprove: boolean;
    branch?: string;
    pathPrefix?: string;
    title?: string;
    body?: string;
    labels?: string[];
    idempotent?: boolean;
  }): Promise<{ branch: string; prNumber: number; headSha: string }> {
    const { owner, repo } = this.cfg;
    const branch = input.branch ?? `submit/${input.submissionId}`;
    const pathPrefix = input.pathPrefix ?? `skills/${input.manifest.author}/${input.manifest.name}`;
    validateManifestPathFields(input.manifest);
    validateRepositoryPath(pathPrefix, { allowEmpty: true });
    for (const file of input.files) {
      validateRepositoryPath(file.path);
      validateRepositoryPath(joinPath(pathPrefix, file.path));
    }
    if (input.idempotent) {
      const existing = await this.findPullRequestByHead(branch);
      if (existing) {
        return { branch, prNumber: existing.number, headSha: await this.getBranchHeadShaOrDefault(branch) };
      }
    }

    let headSha = await this.createOrGetBranch(branch);

    for (const file of input.files) {
      headSha = await this.putFile(
        branch,
        joinPath(pathPrefix, file.path),
        file.content,
        input.submissionId,
      );
    }

    let data: unknown;
    try {
      const response = await this.upload.request('POST /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        title: input.title ?? `[Skill] ${input.manifest.name}@${input.manifest.version}`,
        head: branch,
        base: this.cfg.defaultBranch ?? 'main',
        body: input.body ?? prBody(input.manifest, input.submissionId, input.autoApprove),
        labels: input.labels ?? (input.autoApprove ? ['auto-approve'] : ['needs-review']),
      });
      data = response.data;
    } catch (err) {
      if (!input.idempotent || !isOctokitStatus(err, 409)) {
        throw err;
      }
      const existing = await this.findPullRequestByHead(branch);
      if (!existing) {
        throw err;
      }
      data = existing;
    }
    const pr = forgejoPull(data);

    await this.waitMergeable(pr.number);

    return { branch, prNumber: pr.number, headSha };
  }

  private async getBranchHeadShaOrDefault(branch: string): Promise<string> {
    try {
      return await this.getBranchHeadSha(branch);
    } catch (err) {
      if (!isOctokitStatus(err, 404)) {
        throw err;
      }
      return this.getDefaultBranchHeadSha();
    }
  }

  private async findPullRequestByHead(branch: string): Promise<ForgejoPullResponse | undefined> {
    const { owner, repo } = this.cfg;
    const { data } = await this.upload.request('GET /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      state: 'all',
      per_page: 50,
    });
    const pulls = data as ForgejoPullResponse[];

    return pulls.find((pull) => pull.head?.ref === branch);
  }

  private async waitMergeable(prNumber: number): Promise<void> {
    const { owner, repo } = this.cfg;
    const deadline = Date.now() + 5_000;

    while (Date.now() <= deadline) {
      const { data } = await this.upload.request('GET /repos/{owner}/{repo}/pulls/{index}', {
        owner,
        repo,
        index: prNumber,
      });
      const pr = forgejoPull(data);

      if (pr.mergeable !== undefined && pr.mergeable !== null) {
        return;
      }

      await delay(250);
    }

    throw new Error(`PR ${prNumber} mergeable status not ready`);
  }

  async mergePR(prNumber: number): Promise<{ sha: string }> {
    const { owner, repo } = this.cfg;

    try {
      await this.merge.request('POST /repos/{owner}/{repo}/pulls/{index}/merge', {
        owner,
        repo,
        index: prNumber,
        Do: 'squash',
        merge_message_field: `Approved and published (#${prNumber})`,
        delete_branch_after_merge: true,
      });
    } catch (err) {
      if (!isOctokitStatus(err, 405)) {
        throw err;
      }
    }

    const { data } = await this.merge.request('GET /repos/{owner}/{repo}/pulls/{index}', {
      owner,
      repo,
      index: prNumber,
    });

    if (!data.merge_commit_sha) {
      throw new Error(`PR ${prNumber} not merged`);
    }

    return { sha: data.merge_commit_sha };
  }

  async commitFileToMain(input: {
    owner: string;
    name: string;
    path: string;
    content: NodeBuffer;
    message: string;
    idempotencyKey: string;
  }): Promise<{ sha: string }> {
    const { owner, repo } = this.cfg;
    const branch = `marker/${input.idempotencyKey}`;
    validateManifestPathFields(input);
    validateRepositoryPath(input.path);

    await this.createOrGetBranch(branch);
    await this.putFile(branch, input.path, input.content, input.idempotencyKey);

    const { data } = await this.upload.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title: input.message,
      head: branch,
      base: this.cfg.defaultBranch ?? 'main',
      body: [input.message, `Skill: ${input.owner}/${input.name}`, `File: ${input.path}`].join(
        '\n',
      ),
      labels: ['marker'],
    });
    const pr = forgejoPull(data);

    await this.waitMergeable(pr.number);
    const { sha } = await this.mergePR(pr.number);
    await this.deleteBranch(branch);

    return { sha };
  }

  async deleteBranch(branch: string): Promise<void> {
    const { owner, repo } = this.cfg;

    try {
      await this.merge.request('DELETE /repos/{owner}/{repo}/branches/{branch}', {
        owner,
        repo,
        branch,
      });
    } catch (err) {
      if (!isOctokitStatus(err, 404)) {
        throw err;
      }
    }
  }

  async createAnchorTag(input: {
    tag: string;
    message: string;
    targetSha: string;
    signature?: string;
  }): Promise<{ tagName: string; commitSha: string }> {
    const { owner, repo } = this.cfg;
    const message = input.signature ? `${input.message}\n\n${input.signature}` : input.message;

    let tagObject: ForgejoGitTagResponse | undefined;

    try {
      const { data } = await this.upload.request('POST /repos/{owner}/{repo}/git/tags', {
        owner,
        repo,
        tag: input.tag,
        message,
        object: input.targetSha,
        type: 'commit',
        tagger: {
          name: 'asr-audit-anchor',
          email: process.env.AUDIT_ANCHOR_EMAIL ?? 'audit@asr.local',
          date: new Date().toISOString(),
        },
      });
      tagObject = data as ForgejoGitTagResponse;
    } catch (err) {
      if (!isOctokitStatus(err, 409)) {
        throw err;
      }

      await this.assertExistingAnchorTag(input.tag, input.targetSha, message);
      return { tagName: input.tag, commitSha: input.targetSha };
    }

    try {
      await this.upload.request('POST /repos/{owner}/{repo}/git/refs', {
        owner,
        repo,
        ref: `refs/tags/${input.tag}`,
        sha: tagObject.sha,
      });
    } catch (err) {
      if (!isOctokitStatus(err, 409)) {
        throw err;
      }

      const ref = await this.getTagRef(input.tag);
      if (ref.object.sha !== tagObject.sha) {
        throw err;
      }
    }

    return { tagName: input.tag, commitSha: input.targetSha };
  }

  private async getTagRef(tag: string): Promise<ForgejoGitRefResponse> {
    const { owner, repo } = this.cfg;
    const { data } = await this.upload.request('GET /repos/{owner}/{repo}/git/refs/{ref}', {
      owner,
      repo,
      ref: `tags/${tag}`,
    });

    return data as ForgejoGitRefResponse;
  }

  private async getTagObject(sha: string): Promise<ForgejoGitTagResponse> {
    const { owner, repo } = this.cfg;
    const { data } = await this.upload.request('GET /repos/{owner}/{repo}/git/tags/{sha}', {
      owner,
      repo,
      sha,
    });

    return data as ForgejoGitTagResponse;
  }

  private async assertExistingAnchorTag(
    tag: string,
    targetSha: string,
    message: string,
  ): Promise<void> {
    const ref = await this.getTagRef(tag);
    const tagObject = await this.getTagObject(ref.object.sha);
    const objectSha = tagObject.object?.sha;

    if (objectSha !== targetSha || tagObject.message !== message) {
      throw new Error(`anchor tag ${tag} already exists with different content`);
    }
  }

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: NodeBuffer;
  }): Promise<string> {
    const base = this.cfg.baseUrl.replace(/\/api\/v1\/?$/, '');
    const url = `${base}/api/packages/${input.owner}/generic/${input.name}/${input.version}/skill.zip`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${this.cfg.uploadToken}`,
        'Content-Type': 'application/zip',
      },
      body: input.zipBuffer as unknown as BodyInit,
    });

    if (!res.ok && res.status !== 409) {
      throw new Error(`publishArtifact ${res.status}`);
    }

    return url;
  }
}

export class ForgejoConflictError extends Error {
  readonly branch: string;
  readonly path: string;

  constructor(message: string, input: { branch: string; path: string }) {
    super(message);
    this.name = 'ForgejoConflictError';
    this.branch = input.branch;
    this.path = input.path;
  }
}

const isOctokitStatus = (err: unknown, status: number): boolean =>
  typeof err === 'object' && err !== null && 'status' in err && err.status === status;

const forgejoBranchHeadSha = (data: unknown): string => {
  const branch = data as ForgejoBranchResponse;
  return branch.commit.id;
};

const forgejoFileCommitSha = (data: unknown): string => {
  const putResponse = data as ForgejoContentsPutResponse;
  return putResponse.commit.sha;
};

const forgejoFileContent = (data: unknown): ForgejoContentGetResponse => {
  if (Array.isArray(data)) {
    throw new Error('expected Forgejo file content, got directory listing');
  }
  return data as ForgejoContentGetResponse;
};

const decodeForgejoFileContent = (file: ForgejoContentGetResponse): NodeBuffer => {
  if (file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error('Forgejo file content response is not base64-encoded');
  }
  return Buffer.from(file.content.replace(/\s/g, ''), 'base64');
};

const forgejoFileLastCommitSha = (file: ForgejoContentGetResponse): string => {
  const sha = file.last_commit_sha ?? file.commit?.sha ?? file.commit?.id;
  if (!sha) {
    throw new Error('Forgejo file content response did not include a commit sha');
  }
  return sha;
};

const forgejoPull = (data: unknown): ForgejoPullResponse => data as ForgejoPullResponse;

const joinPath = (prefix: string, path: string): string => {
  validateRepositoryPath(path);
  const joined = prefix ? `${prefix}/${path}` : path;
  validateRepositoryPath(joined);
  return joined;
};

const validateManifestPathFields = (input: { author?: string; owner?: string; name: string }): void => {
  const owner = input.author ?? input.owner;
  if (owner !== undefined && !isValidSkillIdentifier(owner)) {
    throw new Error(`invalid skill owner: ${owner}`);
  }
  if (!isValidSkillIdentifier(input.name)) {
    throw new Error(`invalid skill name: ${input.name}`);
  }
};

const validateRepositoryPath = (path: string, options: { allowEmpty?: boolean } = {}): void => {
  if (options.allowEmpty && path === '') {
    return;
  }
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))
  ) {
    throw new Error(`unsafe repository path: ${path}`);
  }
};

const prBody = (manifest: SkillManifest, submissionId: string, autoApprove: boolean): string =>
  [
    `Submission: ${submissionId}`,
    `Skill: ${manifest.name}@${manifest.version}`,
    `Author: ${manifest.author}`,
    `Review path: ${autoApprove ? 'auto-approve' : 'needs-review'}`,
  ].join('\n');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
