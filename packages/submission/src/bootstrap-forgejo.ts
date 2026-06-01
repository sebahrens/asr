#!/usr/bin/env tsx
import { ForgejoClient } from '@asr/core';

const env = process.env;

const client = new ForgejoClient({
  baseUrl: normalizeForgejoApiBaseUrl(required('FORGEJO_URL')),
  uploadToken: required('FORGEJO_UPLOAD_TOKEN'),
  mergeToken: required('FORGEJO_MERGE_TOKEN'),
  owner: required('FORGEJO_OWNER'),
  repo: required('FORGEJO_REPO'),
  defaultBranch: env.FORGEJO_DEFAULT_BRANCH ?? 'main',
});

const mergeWhitelistUsernames = listEnv('FORGEJO_MERGE_WHITELIST_USERS');
if (mergeWhitelistUsernames.length === 0) {
  mergeWhitelistUsernames.push(env.FORGEJO_MERGE_USERNAME ?? 'asr-merge-bot');
}

await client.protectDefaultBranch({
  branch: env.FORGEJO_DEFAULT_BRANCH ?? 'main',
  mergeWhitelistUsernames,
  statusCheckContexts: listEnv('FORGEJO_STATUS_CHECK_CONTEXTS', ['validate-submission']),
  requiredApprovals: numberEnv('FORGEJO_REQUIRED_APPROVALS', 1),
});

console.log(
  `Protected ${required('FORGEJO_OWNER')}/${required('FORGEJO_REPO')}@${env.FORGEJO_DEFAULT_BRANCH ?? 'main'} with merge whitelist: ${mergeWhitelistUsernames.join(', ')}`,
);

function required(name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeForgejoApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

function listEnv(name: string, fallback: string[] = []): string[] {
  const value = env[name];
  if (!value) {
    return [...fallback];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberEnv(name: string, fallback: number): number {
  const value = env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
