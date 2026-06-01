import { ForgejoClient } from '@asr/core';
import { describe, expect, it } from 'vitest';

const shouldRun = process.env.RUN_FORGEJO_PROTECTION_E2E === '1';
const forgejoUrl = (process.env.FORGEJO_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const owner = process.env.FORGEJO_OWNER ?? 'asr-admin';
const repo = process.env.FORGEJO_REPO ?? 'skills-registry';
const defaultBranch = process.env.FORGEJO_DEFAULT_BRANCH ?? 'main';
const uploadToken = process.env.FORGEJO_UPLOAD_TOKEN ?? '';
const mergeToken = process.env.FORGEJO_MERGE_TOKEN ?? '';
const mergeWhitelistUsernames = (
  process.env.FORGEJO_MERGE_WHITELIST_USERS ??
  process.env.FORGEJO_MERGE_USERNAME ??
  'asr-merge-bot'
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

describe.skipIf(!shouldRun)('Forgejo branch protection bootstrap (real Forgejo)', () => {
  it('is idempotent and rejects upload-token direct writes to main', async () => {
    if (!uploadToken || !mergeToken) {
      throw new Error('RUN_FORGEJO_PROTECTION_E2E=1 requires FORGEJO_UPLOAD_TOKEN and FORGEJO_MERGE_TOKEN');
    }
    if (uploadToken === mergeToken) {
      throw new Error('RUN_FORGEJO_PROTECTION_E2E=1 requires distinct upload and merge tokens');
    }

    const client = new ForgejoClient({
      baseUrl: normalizeForgejoBase(forgejoUrl),
      uploadToken,
      mergeToken,
      owner,
      repo,
      defaultBranch,
    });

    await client.protectDefaultBranch({
      mergeWhitelistUsernames,
    });
    await client.protectDefaultBranch({
      mergeWhitelistUsernames,
    });

    const directPush = await fetch(
      `${forgejoUrl}/api/v1/repos/${owner}/${repo}/contents/.asr-protection-probe/${Date.now()}.txt`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${uploadToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branch: defaultBranch,
          message: 'protection probe: upload token direct write',
          content: Buffer.from('this write must be rejected\n').toString('base64'),
        }),
      },
    );

    expect(directPush.ok).toBe(false);
    expect([401, 403, 405]).toContain(directPush.status);
  });
});

function normalizeForgejoBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}
