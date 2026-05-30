import { ForgejoClient } from '@asr/core';
import { describe, expect, it } from 'vitest';
import { forgejoFromEnv, marketplaceForgejoFromEnv } from './index.js';
import type { Env } from '../env.js';

interface ForgejoClientInternals {
  cfg: {
    owner: string;
    repo: string;
  };
}

const internals = (client: ForgejoClient): ForgejoClientInternals =>
  client as unknown as ForgejoClientInternals;

const stubEnv: Env = {
  NODE_ENV: 'development',
  AUTH_MODE: 'mock',
  PORT: 3001,
  MOCK_USER_SUB: 'mock-user',
  MOCK_USER_ROLES: 'Submitter',
  FORGEJO_URL: 'http://forgejo:3000/api/v1',
  FORGEJO_UPLOAD_TOKEN: 'upload-token',
  FORGEJO_MERGE_TOKEN: 'merge-token',
  FORGEJO_OWNER: 'asr',
  FORGEJO_REPO: 'skills-registry',
  FORGEJO_MARKETPLACE_OWNER: 'asr-marketplace',
  FORGEJO_MARKETPLACE_REPO: 'skill-marketplace',
  NOTIFY_TRANSPORT: 'memory',
  LLM_SCREEN_CONTEXT_TOKENS: 200000,
  LLM_SCREEN_RESERVE_OUTPUT_TOKENS: 8000,
  LLM_SCREEN_CHARS_PER_TOKEN: 3.5,
};

describe('forgejoFromEnv', () => {
  it('constructs a ForgejoClient from Forgejo env vars', () => {
    expect(forgejoFromEnv(stubEnv)).toBeInstanceOf(ForgejoClient);
  });

  it('requires the upload token', () => {
    expect(() =>
      forgejoFromEnv({
        ...stubEnv,
        FORGEJO_UPLOAD_TOKEN: undefined,
      }),
    ).toThrow(/FORGEJO_UPLOAD_TOKEN/);
  });
});

describe('marketplaceForgejoFromEnv', () => {
  it('constructs a ForgejoClient for the marketplace repo coordinates', () => {
    const client = internals(marketplaceForgejoFromEnv(stubEnv));

    expect(client.cfg.owner).toBe('asr-marketplace');
    expect(client.cfg.repo).toBe('skill-marketplace');
  });
});
