import { ForgejoClient } from '@asr/core';
import { getEnv, type Env } from '../env.js';

export { ForgejoClient } from '@asr/core';

export function forgejoFromEnv(e: Env = getEnv()): ForgejoClient {
  const baseUrl = required(e.FORGEJO_URL, 'FORGEJO_URL');
  const uploadToken = required(e.FORGEJO_UPLOAD_TOKEN, 'FORGEJO_UPLOAD_TOKEN');
  const mergeToken = required(e.FORGEJO_MERGE_TOKEN, 'FORGEJO_MERGE_TOKEN');
  const owner = required(e.FORGEJO_OWNER, 'FORGEJO_OWNER');
  const repo = required(e.FORGEJO_REPO, 'FORGEJO_REPO');

  return new ForgejoClient({
    baseUrl: normalizeForgejoApiBaseUrl(baseUrl),
    uploadToken,
    mergeToken,
    owner,
    repo,
    defaultBranch: 'main',
  });
}

export function marketplaceForgejoFromEnv(e: Env = getEnv()): ForgejoClient {
  const baseUrl = required(e.FORGEJO_URL, 'FORGEJO_URL');
  const uploadToken = required(e.FORGEJO_UPLOAD_TOKEN, 'FORGEJO_UPLOAD_TOKEN');
  const mergeToken = required(e.FORGEJO_MERGE_TOKEN, 'FORGEJO_MERGE_TOKEN');
  const owner = required(e.FORGEJO_MARKETPLACE_OWNER, 'FORGEJO_MARKETPLACE_OWNER');
  const repo = required(e.FORGEJO_MARKETPLACE_REPO, 'FORGEJO_MARKETPLACE_REPO');

  return new ForgejoClient({
    baseUrl: normalizeForgejoApiBaseUrl(baseUrl),
    uploadToken,
    mergeToken,
    owner,
    repo,
    defaultBranch: 'main',
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function normalizeForgejoApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}
