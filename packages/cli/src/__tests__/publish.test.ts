import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/device-code.js';
import { __setKeytarImporterForTest } from '../auth/token-store.js';
import { runPublish } from '../commands/publish.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAsrUrl = process.env.ASR_URL;
let configHome: string;
let workDir: string;

async function writeFixture(opts: {
  manifest?: string;
  code?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(workDir, 'skill-'));
  if (opts.manifest !== undefined) {
    await writeFile(join(dir, 'manifest.yaml'), opts.manifest);
  }
  await writeFile(join(dir, 'SKILL.md'), '---\nname: demo\nversion: 1.0.0\n---\n# Demo\n');
  if (opts.code) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'run.py'), 'print("hi")\n');
  }
  return dir;
}

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'asr-publish-'));
  workDir = await mkdtemp(join(tmpdir(), 'asr-publish-work-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.ASR_URL = 'http://localhost:3001';
  __setKeytarImporterForTest(async () => {
    throw new Error('keytar unavailable');
  });
});

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
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

describe('runPublish', () => {
  it('uploads an md-only skill and prints id and status', async () => {
    const dir = await writeFixture({ manifest: 'name: demo\nversion: 1.0.0\n' });

    const responseBody = {
      id: '01J0000000000000000000000A',
      status: { phase: 'uploaded' as const },
      manifest: { name: 'demo', version: '1.0.0' },
      contentHash: 'sha256:abc',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(responseBody, { status: 201 }));
    const logs: string[] = [];

    await runPublish(dir, { fetch: fetchMock, log: (m) => logs.push(m) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const printed = logs.find((m) => m.includes('"id"')) ?? '';
    expect(printed).toContain('01J0000000000000000000000A');
    expect(printed).toContain('uploaded');
    const pathLine = logs.find((m) => m.includes('predicted path:')) ?? '';
    expect(pathLine).toContain('auto-approve');
  });

  it('exits non-zero with no HTTP request when the manifest is missing version', async () => {
    const dir = await writeFixture({ manifest: 'name: demo\n' });

    const fetchMock = vi.fn<FetchLike>();
    const errors: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    });

    await expect(
      runPublish(dir, { fetch: fetchMock, errorLog: (m) => errors.push(m) }),
    ).rejects.toThrow('process.exit:1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('version');

    exitSpy.mockRestore();
  });

  it('streams status transitions with --watch until a terminal phase', async () => {
    const dir = await writeFixture({ manifest: 'name: demo\nversion: 1.0.0\n', code: true });

    const submissionId = '01J0000000000000000000000B';
    const phases: Array<{ phase: string; [k: string]: unknown }> = [
      { phase: 'classifying' },
      { phase: 'questionnaire-pending', questionnaireId: 'q1' },
      { phase: 'scanning', scanJobId: 's1' },
      { phase: 'compliance-review' },
      { phase: 'published', publishedAt: '2026-05-27T01:00:00.000Z', mergeCommit: 'abc' },
    ];

    let call = 0;
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        return jsonResponse(
          {
            id: submissionId,
            status: { phase: 'uploaded' },
            manifest: { name: 'demo', version: '1.0.0' },
            contentHash: 'sha256:abc',
            createdAt: '2026-05-27T00:00:00.000Z',
          },
          { status: 201 },
        );
      }
      const next = phases[Math.min(call, phases.length - 1)];
      call++;
      return jsonResponse({ id: submissionId, status: next });
    });

    const logs: string[] = [];

    await runPublish(dir, {
      watch: true,
      fetch: fetchMock,
      sleep: async () => {},
      pollIntervalMs: 1,
      log: (m) => logs.push(m),
    });

    const transitionLines = logs.filter((m) => m.startsWith('→') || m.includes('→ '));
    const seen = transitionLines.join('\n');
    expect(seen).toContain('classifying');
    expect(seen).toContain('published');
    expect(logs.some((m) => m.includes('terminal phase:') && m.includes('published'))).toBe(true);
    const pathLine = logs.find((m) => m.includes('predicted path:')) ?? '';
    expect(pathLine).toContain('code-containing');
  });
});
