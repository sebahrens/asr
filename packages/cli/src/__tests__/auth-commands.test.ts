import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/device-code.js';
import {
  __setKeytarImporterForTest,
  getStoredTokens,
  storeTokens,
  type StoredTokens,
} from '../auth/token-store.js';
import { registerLogin, registerLogout, registerWhoami } from '../commands/auth.js';

const state = vi.hoisted(() => ({
  config: { defaultTarget: 'project' as const } as {
    defaultTarget: 'project';
    registry?: string;
  },
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => state.config),
}));

function testProgram(options: { fetch?: FetchLike } = {}): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerLogin(program, options);
  registerWhoami(program);
  registerLogout(program);
  return program;
}

function accessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
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
    state.config = { defaultTarget: 'project' };
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

  it('logs in with device code flow and stores returned tokens', async () => {
    process.env.ASR_URL = 'https://registry.example.com';
    const token = accessToken({
      preferred_username: 'user@company.com',
      roles: ['Submitter', 'ComplianceOfficer'],
    });
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.endsWith('/devicecode')) {
        return jsonResponse({
          verification_uri: 'https://microsoft.com/devicelogin',
          user_code: 'ABCD-EFGH',
          device_code: 'device-code',
          interval: 1,
        });
      }

      if (url.endsWith('/token')) {
        return jsonResponse({
          access_token: token,
          refresh_token: 'refresh-token',
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    await testProgram({ fetch: fetchMock }).parseAsync(['node', 'asr', 'login']);

    await expect(getStoredTokens()).resolves.toMatchObject({
      accessToken: token,
      refreshToken: 'refresh-token',
      account: 'user@company.com',
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Logged in as'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('user@company.com'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Submitter, ComplianceOfficer'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(token));
  });

  it('skips login and stores nothing when auth is disabled for a non-HTTPS ASR_URL', async () => {
    process.env.ASR_URL = 'http://localhost:9999';
    const fetchMock = vi.fn<FetchLike>();

    await testProgram({ fetch: fetchMock }).parseAsync(['node', 'asr', 'login']);

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getStoredTokens()).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Authentication is skipped in dev mode'));
  });

  it('prints cached identity and roles for whoami', async () => {
    process.env.ASR_URL = 'https://registry.example.com';
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
    process.env.ASR_URL = 'https://registry.example.com';
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

  it('reports not signed in when auth is disabled for the configured registry', async () => {
    state.config = { defaultTarget: 'project', registry: 'http://localhost:9999' };
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@company.com', roles: ['Submitter'] }),
      expiresAt: 1_800_000_000,
      account: 'user@company.com',
    });

    await testProgram().parseAsync(['node', 'asr', 'whoami']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Not signed in'));
  });
});
