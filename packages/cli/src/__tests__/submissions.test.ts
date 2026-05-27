import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/device-code.js';
import { __setKeytarImporterForTest } from '../auth/token-store.js';
import { runStatus, runSubmissions } from '../commands/submissions.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAsrUrl = process.env.ASR_URL;
let configHome: string;

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'asr-submissions-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.ASR_URL = 'http://localhost:3001';
  __setKeytarImporterForTest(async () => {
    throw new Error('keytar unavailable');
  });
});

afterEach(async () => {
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

describe('runStatus', () => {
  it('renders submission detail fields returned by the API', async () => {
    const detail = {
      id: '01J0000000000000000000000A',
      status: { phase: 'compliance-review' as const },
      createdAt: '2026-05-27T00:00:00.000Z',
      manifest: { name: 'demo', version: '1.2.3' },
      contentHash: 'sha256:abc',
      classification: 'md-only',
      submittedBy: 'user-sub-1',
      prNumber: 42,
      branchName: 'submission/demo/1.2.3',
    };
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      expect(String(input)).toBe(
        'http://localhost:3001/api/v1/submissions/01J0000000000000000000000A',
      );
      return jsonResponse(detail);
    });
    const logs: string[] = [];

    await runStatus(detail.id, { fetch: fetchMock, log: (m) => logs.push(m) });

    const joined = logs.join('\n');
    expect(joined).toContain(detail.id);
    expect(joined).toContain('compliance-review');
    expect(joined).toContain('2026-05-27T00:00:00.000Z');
    expect(joined).toContain('demo');
    expect(joined).toContain('1.2.3');
    expect(joined).toContain('md-only');
    expect(joined).toContain('sha256:abc');
    expect(joined).toContain('user-sub-1');
    expect(joined).toContain('42');
  });

  it('exits non-zero on API error', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'submission_not_found' }, { status: 404 }),
    );
    const errors: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    });

    await expect(
      runStatus('missing', { fetch: fetchMock, errorLog: (m) => errors.push(m) }),
    ).rejects.toThrow('process.exit:1');

    expect(errors.join('\n')).toContain('submission_not_found');
    exitSpy.mockRestore();
  });
});

describe('runSubmissions', () => {
  it('renders a table row per submission returned by the stub', async () => {
    const rows = [
      {
        id: '01J0000000000000000000000A',
        status: { phase: 'uploaded' as const },
        createdAt: '2026-05-27T00:00:00.000Z',
      },
      {
        id: '01J0000000000000000000000B',
        status: { phase: 'published' as const },
        createdAt: '2026-05-26T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      expect(String(input)).toBe('http://localhost:3001/api/v1/submissions');
      return jsonResponse({ submissions: rows });
    });
    const logs: string[] = [];

    await runSubmissions({ fetch: fetchMock, log: (m) => logs.push(m) });

    const joined = logs.join('\n');
    expect(joined).toContain('01J0000000000000000000000A');
    expect(joined).toContain('uploaded');
    expect(joined).toContain('2026-05-27T00:00:00.000Z');
    expect(joined).toContain('01J0000000000000000000000B');
    expect(joined).toContain('published');
    expect(joined).toContain('2026-05-26T00:00:00.000Z');
  });

  it('also accepts a bare array list response', async () => {
    const rows = [
      {
        id: '01J0000000000000000000000C',
        status: 'compliance-review',
        createdAt: '2026-05-27T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(rows));
    const logs: string[] = [];

    await runSubmissions({ fetch: fetchMock, log: (m) => logs.push(m) });

    const joined = logs.join('\n');
    expect(joined).toContain('01J0000000000000000000000C');
    expect(joined).toContain('compliance-review');
  });

  it('prints an empty-state message when there are no submissions', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ submissions: [] }));
    const logs: string[] = [];

    await runSubmissions({ fetch: fetchMock, log: (m) => logs.push(m) });

    expect(logs.join('\n')).toContain('No submissions');
  });
});
