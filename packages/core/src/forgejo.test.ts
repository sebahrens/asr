import { describe, expect, it } from 'vitest';
import { Octokit } from '@octokit/rest';
import { ForgejoClient, type ForgejoConfig } from './forgejo.js';

interface ForgejoClientInternals {
  cfg: ForgejoConfig;
  upload: Octokit;
  merge: Octokit;
}

const internals = (client: ForgejoClient): ForgejoClientInternals =>
  client as unknown as ForgejoClientInternals;

const octokitBaseUrl = (client: Octokit): string => client.request.endpoint.DEFAULTS.baseUrl;

describe('ForgejoClient', () => {
  it('constructs distinct upload and merge Octokit clients with the configured baseUrl', () => {
    const cfg: ForgejoConfig = {
      baseUrl: 'https://forgejo.example.test/api/v1',
      uploadToken: 'upload-token',
      mergeToken: 'merge-token',
      owner: 'asr',
      repo: 'skills',
      defaultBranch: 'main',
    };

    const client = internals(new ForgejoClient(cfg));

    expect(client.cfg).toBe(cfg);
    expect(client.upload).toBeInstanceOf(Octokit);
    expect(client.merge).toBeInstanceOf(Octokit);
    expect(client.upload).not.toBe(client.merge);
    expect(octokitBaseUrl(client.upload)).toBe(cfg.baseUrl);
    expect(octokitBaseUrl(client.merge)).toBe(cfg.baseUrl);
  });
});
