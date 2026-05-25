import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setKeytarImporterForTest, storeTokens, type StoredTokens } from '../auth/token-store.js';
import { registerLogout, registerWhoami } from '../commands/auth.js';

function testProgram(): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerWhoami(program);
  registerLogout(program);
  return program;
}

function accessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('auth commands', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAsrUrl = process.env.ASR_URL;
  let configHome: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), 'asr-auth-commands-'));
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.ASR_URL;
    __setKeytarImporterForTest(async () => {
      throw new Error('keytar unavailable');
    });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    await rm(configHome, { recursive: true, force: true });

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
  });

  it('prints cached identity and roles for whoami', async () => {
    const tokens: StoredTokens = {
      accessToken: accessToken({
        preferred_username: 'user@company.com',
        roles: ['Submitter', 'ComplianceOfficer'],
      }),
      refreshToken: 'refresh-token',
      expiresAt: 1_800_000_000,
      account: 'fallback@company.com',
    };
    await storeTokens(tokens);

    await testProgram().parseAsync(['node', 'asr', 'whoami']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Signed in as'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('user@company.com'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Submitter, ComplianceOfficer'));
  });

  it('clears cached tokens on logout so whoami reports not signed in', async () => {
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@company.com', roles: ['Submitter'] }),
      expiresAt: 1_800_000_000,
      account: 'user@company.com',
    });

    await testProgram().parseAsync(['node', 'asr', 'logout']);
    await testProgram().parseAsync(['node', 'asr', 'whoami']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Signed out'));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Not signed in'));
  });

  it('reports not signed in when auth is disabled for a non-HTTPS ASR_URL', async () => {
    process.env.ASR_URL = 'http://localhost:9999';
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@company.com', roles: ['Submitter'] }),
      expiresAt: 1_800_000_000,
      account: 'user@company.com',
    });

    await testProgram().parseAsync(['node', 'asr', 'whoami']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Not signed in'));
  });
});
