import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
