import { Octokit } from '@octokit/rest';
import type { Buffer } from 'node:buffer';
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

interface ForgejoPullResponse {
  number: number;
  mergeable?: boolean | null;
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

  private async putFile(
    branch: string,
    path: string,
    content: Buffer,
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

    return this.getBranchHeadSha(branch);
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

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }): Promise<{ branch: string; prNumber: number; headSha: string }> {
    const { owner, repo } = this.cfg;
    const branch = `submit/${input.submissionId}`;
    const skillPath = `skills/${input.manifest.author}/${input.manifest.name}`;
    let headSha = await this.createOrGetBranch(branch);

    for (const file of input.files) {
      headSha = await this.putFile(
        branch,
        `${skillPath}/${file.path}`,
        file.content,
        input.submissionId,
      );
    }

    const { data } = await this.upload.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title: `[Skill] ${input.manifest.name}@${input.manifest.version}`,
      head: branch,
      base: this.cfg.defaultBranch ?? 'main',
      body: prBody(input.manifest, input.submissionId, input.autoApprove),
      labels: input.autoApprove ? ['auto-approve'] : ['needs-review'],
    });
    const pr = forgejoPull(data);

    await this.waitMergeable(pr.number);

    return { branch, prNumber: pr.number, headSha };
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

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
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

const forgejoPull = (data: unknown): ForgejoPullResponse => data as ForgejoPullResponse;

const prBody = (manifest: SkillManifest, submissionId: string, autoApprove: boolean): string =>
  [
    `Submission: ${submissionId}`,
    `Skill: ${manifest.name}@${manifest.version}`,
    `Author: ${manifest.author}`,
    `Review path: ${autoApprove ? 'auto-approve' : 'needs-review'}`,
  ].join('\n');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
