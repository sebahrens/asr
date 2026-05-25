import { ForgejoClient } from '@asr/core';
import { describe, expect, it } from 'vitest';
import { forgejoFromEnv } from './index.js';
import type { Env } from '../env.js';

const stubEnv: Env = {
  NODE_ENV: 'development',
  AUTH_MODE: 'mock',
  PORT: 3001,
  FORGEJO_URL: 'http://forgejo:3000/api/v1',
  FORGEJO_UPLOAD_TOKEN: 'upload-token',
  FORGEJO_MERGE_TOKEN: 'merge-token',
  FORGEJO_OWNER: 'asr',
  FORGEJO_REPO: 'skills-registry',
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
