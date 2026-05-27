import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runToken } from './commands/token.js';
import { formatExportLine } from './token-export.js';

const originalAsrUrl = process.env.ASR_URL;

beforeEach(() => {
  process.env.ASR_URL = 'http://localhost:3001';
});

afterEach(() => {
  if (originalAsrUrl === undefined) {
    delete process.env.ASR_URL;
  } else {
    process.env.ASR_URL = originalAsrUrl;
  }
});

describe('runToken', () => {
  it('--export writes the cached token as a shell-eval line to stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const getToken = vi.fn(async () => 'cached-access-token');
    const mintToken = vi.fn(async () => 'should-not-be-called');
    const writeEnv = vi.fn(async () => {});

    await runToken(
      { export: true },
      {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
        getToken,
        mintToken,
        writeEnv,
      },
    );

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(mintToken).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe(`${formatExportLine('cached-access-token')}\n`);
    expect(stderr).toEqual([]);
  });

  it('--write-env writes the file via writeEnv and produces no stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const getToken = vi.fn(async () => 'cached-access-token');
    const mintToken = vi.fn(async () => 'should-not-be-called');
    const writeEnv = vi.fn(async () => {});

    await runToken(
      { writeEnv: '/tmp/asr-env' },
      {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
        getToken,
        mintToken,
        writeEnv,
      },
    );

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(mintToken).not.toHaveBeenCalled();
    expect(writeEnv).toHaveBeenCalledWith('/tmp/asr-env', 'cached-access-token');
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it('--once prints a freshly minted derived token to stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const getToken = vi.fn(async () => 'cached-access-token');
    const mintToken = vi.fn(async () => 'minted-short-lived-token');
    const writeEnv = vi.fn(async () => {});

    await runToken(
      { once: true },
      {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
        getToken,
        mintToken,
        writeEnv,
      },
    );

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('minted-short-lived-token\n');
    expect(stdout.join('')).not.toContain('cached-access-token');
    expect(stderr).toEqual([]);
  });

  it('bare invocation (no flag) writes a usage hint to stderr only and exits 64', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const getToken = vi.fn(async () => 'cached-access-token');
    const mintToken = vi.fn(async () => 'minted');
    const writeEnv = vi.fn(async () => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(
      runToken(
        {},
        {
          stdout: (m) => stdout.push(m),
          stderr: (m) => stderr.push(m),
          getToken,
          mintToken,
          writeEnv,
        },
      ),
    ).rejects.toThrow('process.exit:64');

    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Usage: asr token');
    expect(getToken).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('multiple flags also exit 64 with usage hint on stderr', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(
      runToken(
        { export: true, once: true },
        {
          stdout: (m) => stdout.push(m),
          stderr: (m) => stderr.push(m),
          getToken: vi.fn(),
          mintToken: vi.fn(),
          writeEnv: vi.fn(),
        },
      ),
    ).rejects.toThrow('process.exit:64');

    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Usage: asr token');
    exitSpy.mockRestore();
  });

  it('passes baseUrl + fetch through to getToken on --export', async () => {
    const fetchImpl = vi.fn();
    const getToken = vi.fn(async () => 'tkn');
    const writeEnv = vi.fn(async () => {});
    const mintToken = vi.fn(async () => 'minted');

    await runToken(
      { export: true },
      {
        baseUrl: 'http://localhost:9999',
        fetch: fetchImpl,
        stdout: () => {},
        stderr: () => {},
        getToken,
        mintToken,
        writeEnv,
      },
    );

    expect(getToken).toHaveBeenCalledWith('http://localhost:9999', {
      fetch: fetchImpl,
    });
  });
});
