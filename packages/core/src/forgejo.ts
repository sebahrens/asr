import { Octokit } from '@octokit/rest';

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
}
