import { mkdtemp, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function readAllFiles(dir: string, excludeNames = new Set<string>()): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const contents: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || excludeNames.has(entry.name)) continue;
    contents.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }

  return contents.join('\n');
}

describe('config secrets', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAsrConfigHome = process.env.ASR_CONFIG_HOME;
  let configHome: string;

  beforeEach(async () => {
    vi.resetModules();
    configHome = await mkdtemp(join(tmpdir(), 'asr-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.ASR_CONFIG_HOME = join(configHome, 'conf');
  });

  afterEach(() => {
    vi.resetModules();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalAsrConfigHome === undefined) {
      delete process.env.ASR_CONFIG_HOME;
    } else {
      process.env.ASR_CONFIG_HOME = originalAsrConfigHome;
    }
  });

  it('stores token config outside plaintext Conf and redacts rendered config', async () => {
    const tokenStore = await import('./auth/token-store.js');
    tokenStore.__setKeytarImporterForTest(async () => {
      throw new Error('keytar unavailable');
    });

    const { getConfig, getConfigWithSecrets, redactConfig, setConfig } = await import(
      './config.js'
    );

    await setConfig('token', 'registry-secret');
    await setConfig('githubToken', 'pat-secret');

    expect(getConfig()).toEqual({
      defaultTarget: 'project',
    });
    await expect(getConfigWithSecrets()).resolves.toMatchObject({
      token: 'registry-secret',
      githubToken: 'pat-secret',
    });
    expect(redactConfig(await getConfigWithSecrets())).toMatchObject({
      token: '<redacted>',
      githubToken: '<redacted>',
    });

    const storedContents = await readAllFiles(configHome, new Set(['config-secrets.json']));
    expect(storedContents).not.toContain('"token": "registry-secret"');
    expect(storedContents).not.toContain('"githubToken": "pat-secret"');
  });
});
