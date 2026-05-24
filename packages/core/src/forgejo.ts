import { Octokit } from '@octokit/rest';
import type { Buffer } from 'node:buffer';

export interface ForgejoConfig {
  baseUrl: string;
  uploadToken: string;
  mergeToken: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
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
