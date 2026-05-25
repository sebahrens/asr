import { mkdtemp, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setKeytarImporterForTest,
  clearTokens,
  getStoredTokens,
  storeTokens,
  type StoredTokens,
} from '../auth/token-store.js';

describe('token store', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
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
});
