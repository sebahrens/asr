import { mkdir, mkdtemp, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setKeytarImporterForTest,
  clearTokens,
  getConfigSecret,
  getStoredTokens,
  storeConfigSecret,
  storeTokens,
  type StoredTokens,
} from '../auth/token-store.js';

describe('token store', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const legacyForgejoTokenKey = ['git', 'hub', 'Token'].join('');
  let configHome: string;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), 'asr-token-store-'));
    process.env.XDG_CONFIG_HOME = configHome;
    __setKeytarImporterForTest(async () => {
      throw new Error('keytar unavailable');
    });
  });

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it('round-trips through the 0600 file fallback and clears stored tokens', async () => {
    const tokens: StoredTokens = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000,
      account: 'user@example.com',
    };

    await storeTokens(tokens);

    await expect(getStoredTokens()).resolves.toEqual(tokens);

    const tokenPath = join(configHome, 'asr', 'token.json');
    const tokenStat = await stat(tokenPath);
    expect(tokenStat.mode & 0o777).toBe(0o600);

    await clearTokens();

    await expect(getStoredTokens()).resolves.toBeNull();
  });

  it('round-trips config secrets through the 0600 file fallback', async () => {
    await storeConfigSecret('token', 'registry-token');
    await storeConfigSecret('forgejoToken', 'pat-token');

    await expect(getConfigSecret('token')).resolves.toBe('registry-token');
    await expect(getConfigSecret('forgejoToken')).resolves.toBe('pat-token');

    const secretsPath = join(configHome, 'asr', 'config-secrets.json');
    const secretsStat = await stat(secretsPath);
    expect(secretsStat.mode & 0o777).toBe(0o600);
  });

  it('reads the legacy Forgejo token key from the fallback secret file', async () => {
    const secretsPath = join(configHome, 'asr', 'config-secrets.json');
    await mkdir(join(configHome, 'asr'), { recursive: true });
    await writeFile(
      secretsPath,
      JSON.stringify({ [legacyForgejoTokenKey]: 'legacy-pat-token' }, null, 2)
    );

    await expect(getConfigSecret('forgejoToken')).resolves.toBe('legacy-pat-token');
  });
});
