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
