import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { HashMismatchError } from './download.js';
import { installSkill } from './install.js';

type ServerMode = 'ok' | 'tampered' | 'yanked';

describe('installSkill integration', () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let registry: TestRegistry;
  let originalAsrUrl: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'asr-install-integration-'));
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    originalAsrUrl = process.env.ASR_URL;
    registry = await startTestRegistry();
    process.env.ASR_URL = registry.baseUrl;
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await registry.close();
    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('downloads, verifies, extracts, and records a real skill zip', async () => {
    registry.mode = 'ok';

    const result = await installSkill('acme/demo');

    expect(result).toMatchObject({
      owner: 'acme',
      name: 'demo',
      version: '1.2.3',
      contentHash: registry.contentHash,
      sourceUrl: `${registry.baseUrl}/files/demo.zip`,
      yanked: false,
    });
    expect(result.locations).toEqual([
      {
        agent: 'claude',
        dir: join(tempDir, '.claude', 'skills', 'demo'),
        files: ['SKILL.md', 'docs/readme.txt'],
      },
    ]);

    await expect(readFile(join(tempDir, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Demo');
    await expect(readFile(join(tempDir, '.claude', 'skills', 'demo', 'docs', 'readme.txt'), 'utf8'))
      .resolves.toBe('hello from zip\n');

    const lock = JSON.parse(await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf8'));
    expect(lock.skills.demo).toMatchObject({
      name: 'demo',
      source: 'registry:acme/demo',
      version: '1.2.3',
      contentHash: registry.contentHash,
      sourceUrl: `${registry.baseUrl}/files/demo.zip`,
    });
  });

  it('rejects tampered bytes before extracting files or changing the lockfile', async () => {
    registry.mode = 'tampered';
    const lockPath = join(tempDir, '.agent', 'asr.lock.json');
    const originalLock = JSON.stringify({ version: 1, skills: { existing: { name: 'existing' } } }, null, 2);
    await mkdir(join(tempDir, '.agent'), { recursive: true });
    await writeFile(lockPath, originalLock, 'utf8');

    await expect(installSkill('acme/demo')).rejects.toBeInstanceOf(HashMismatchError);

    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(originalLock);
  });

  it('refuses a yanked redirect header before downloading', async () => {
    registry.mode = 'yanked';
    const lockPath = join(tempDir, '.agent', 'asr.lock.json');
    const originalLock = JSON.stringify({ version: 1, skills: {} }, null, 2);
    await mkdir(join(tempDir, '.agent'), { recursive: true });
    await writeFile(lockPath, originalLock, 'utf8');

    await expect(installSkill('acme/demo')).rejects.toThrow(
      'Refusing to install acme/demo@1.2.3: version is yanked',
    );

    expect(registry.downloads).toBe(0);
    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(originalLock);
  });
});

interface TestRegistry {
  baseUrl: string;
  contentHash: string;
  mode: ServerMode;
  downloads: number;
  close: () => Promise<void>;
}

async function startTestRegistry(): Promise<TestRegistry> {
  const zip = await buildZip([
    { path: 'SKILL.md', contents: skillMd() },
    { path: 'docs/readme.txt', contents: 'hello from zip\n' },
  ]);
  const tamperedZip = Buffer.concat([zip, Buffer.from('tampered')]);
  const contentHash = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
  const state = { mode: 'ok' as ServerMode, downloads: 0 };

  const server = createServer((req, res) => {
    handleRequest(req, res, state, zip, tamperedZip, contentHash);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test registry did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    contentHash,
    get mode() {
      return state.mode;
    },
    set mode(mode: ServerMode) {
      state.mode = mode;
    },
    get downloads() {
      return state.downloads;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: { mode: ServerMode; downloads: number },
  zip: Buffer,
  tamperedZip: Buffer,
  contentHash: string,
): void {
  const host = req.headers.host;
  const path = new URL(req.url ?? '/', `http://${host}`).pathname;

  if (path === '/api/v1/skills/acme/demo') {
    sendJson(res, detail(contentHash));
    return;
  }

  if (path === '/api/v1/skills/acme/demo/v/1.2.3/download') {
    res.statusCode = 302;
    res.setHeader('Location', `http://${host}/files/demo.zip`);
    if (state.mode === 'yanked') {
      res.setHeader('X-ASR-Yanked', 'true');
    }
    res.end();
    return;
  }

  if (path === '/files/demo.zip') {
    state.downloads += 1;
    const body = state.mode === 'tampered' ? tamperedZip : zip;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(body.byteLength));
    res.end(body);
    return;
  }

  res.statusCode = 404;
  res.end('not found');
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function detail(contentHash: string): unknown {
  return {
    owner: 'acme',
    name: 'demo',
    latestVersion: '1.2.3',
    description: 'demo skill',
    tags: [],
    kind: 'skill',
    publishedAt: '2026-05-23T10:00:00Z',
    downloadCount: 0,
    riskAssessmentLatest: 'low',
    manifestLatest: {},
    versions: [
      {
        owner: 'acme',
        name: 'demo',
        version: '1.2.3',
        contentHash,
        publishedAt: '2026-05-23T10:00:00Z',
        publishedBy: 'u',
        approvedBy: null,
        prNumber: 1,
        mergeCommit: 'abc',
        yanked: false,
        riskAssessment: 'low',
      },
    ],
  };
}

function skillMd(): string {
  return `---
name: demo
version: 1.2.3
author: asr-team
description: Demo skill.
tags:
  - demo
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
---

# Demo
`;
}

function buildZip(entries: Array<{ path: string; contents: string }>): Promise<Buffer> {
  return new Promise((resolveBuf, rejectBuf) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.contents), entry.path);
    }
    zip.end();

    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolveBuf(Buffer.concat(chunks)));
    zip.outputStream.on('error', rejectBuf);
  });
}
