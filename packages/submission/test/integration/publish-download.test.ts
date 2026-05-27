import {
  ForgejoClient,
  canonicalHash,
  type CanonicalFile,
  type SkillManifest,
} from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { runMigrations } from '../../src/db/migrations/index.js';
import { insertSubmission } from '../../src/db/repositories/submissions.js';
import { createRegistryRoutes } from '../../src/http/registry.js';
import { packSkillZip } from '../../src/zip/pack.js';

// This test exercises the publish → download contract against a real Forgejo
// instance (testcontainer or the dev compose stack). It is gated behind
// RUN_FORGEJO_INTEGRATION=1 so `pnpm test` stays hermetic. Run via:
//
//   pnpm --filter @asr/submission test:integration
//
// with FORGEJO_URL + FORGEJO_UPLOAD_TOKEN set to a Forgejo that has the
// generic package registry enabled (default in the docker-compose stack).
const shouldRun = process.env.RUN_FORGEJO_INTEGRATION === '1';
const forgejoUrl = (process.env.FORGEJO_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const forgejoToken =
  process.env.FORGEJO_UPLOAD_TOKEN ?? process.env.FORGEJO_ADMIN_TOKEN ?? '';

describe.skipIf(!shouldRun)('publish → download round trip (real Forgejo)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('serves the uploaded skill.zip and the canonical hash matches contentHash', async () => {
    if (!forgejoToken) {
      throw new Error(
        'RUN_FORGEJO_INTEGRATION=1 requires FORGEJO_UPLOAD_TOKEN (or FORGEJO_ADMIN_TOKEN)',
      );
    }

    const owner = 'acme';
    const name = 'x';
    const version = '1.0.0';

    const files: Array<{ path: string; content: Buffer }> = [
      { path: 'SKILL.md', content: Buffer.from(skillMdFixture({ owner, name, version })) },
    ];
    const contentHash = `sha256:${canonicalHash(files.map(toCanonicalFile))}`;
    const zipBuffer = await packSkillZip(files);

    const forgejo = new ForgejoClient({
      baseUrl: normalizeForgejoBase(forgejoUrl),
      uploadToken: forgejoToken,
      mergeToken: forgejoToken,
      owner,
      repo: name,
      defaultBranch: 'main',
    });

    await forgejo.publishArtifact({ owner, name, version, zipBuffer });

    db = new Database(':memory:');
    runMigrations(db);

    const publishedAt = '2026-05-27T00:00:00.000Z';
    insertSubmission(db, {
      id: `sub-${owner}-${name}-${version}`,
      manifestJson: JSON.stringify(manifestFor({ owner, name, version })),
      classification: 'md-only',
      contentHash,
      submittedAt: publishedAt,
      submittedBy: 'integration@example.test',
      statusPhase: 'published',
      statusJson: JSON.stringify({
        phase: 'published',
        publishedAt,
        mergeCommit: 'integration-merge',
      }),
    });

    const app = new Hono();
    app.route('/api/v1/skills', createRegistryRoutes({ db, forgejoUrl }));

    const redirectRes = await app.request(
      `/api/v1/skills/${owner}/${name}/v/${version}/download`,
      { redirect: 'manual' },
    );
    expect(redirectRes.status).toBe(302);

    const location = redirectRes.headers.get('Location');
    expect(location).toBe(
      `${forgejoUrl}/api/packages/${owner}/generic/${name}/${version}/skill.zip`,
    );

    const downloadRes = await fetch(location!);
    expect(downloadRes.status).toBe(200);
    const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
    expect(downloadedBytes.length).toBeGreaterThan(0);

    const extracted = await readZipCanonical(downloadedBytes);
    const downloadedHash = `sha256:${canonicalHash(extracted)}`;
    expect(downloadedHash).toBe(contentHash);
  });
});

function toCanonicalFile(file: { path: string; content: Buffer }): CanonicalFile {
  return { path: file.path, content: new Uint8Array(file.content) };
}

function normalizeForgejoBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

function manifestFor(input: { owner: string; name: string; version: string }): SkillManifest {
  return {
    name: input.name,
    version: input.version,
    author: input.owner,
    description: 'Integration test skill for publish→download round trip',
    tags: ['integration'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };
}

function skillMdFixture(input: { owner: string; name: string; version: string }): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.owner}
description: Integration test skill for publish→download round trip
tags:
  - integration
kind: skill
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
---

# ${input.name}

Integration test skill body.
`;
}

async function readZipCanonical(buffer: Buffer): Promise<CanonicalFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('yauzl returned no zip'));
        return;
      }

      const files: CanonicalFile[] = [];

      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(streamErr ?? new Error('openReadStream returned no stream'));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.push({
              path: entry.fileName,
              content: new Uint8Array(Buffer.concat(chunks)),
            });
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });

      zip.on('end', () => resolve(files));
      zip.on('error', reject);

      zip.readEntry();
    });
  });
}
