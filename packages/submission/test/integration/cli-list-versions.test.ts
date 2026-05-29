import { serve, type ServerType } from '@hono/node-server';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listVersions as cliListVersions } from '../../../cli/src/registry-client.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { insertSubmission } from '../../src/db/repositories/submissions.js';
import type { createApp as CreateApp } from '../../src/index.js';

let createApp: typeof CreateApp;
let db: Database.Database;
let server: ServerType;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter');

  ({ createApp } = await import('../../src/index.js'));

  db = new Database(':memory:');
  runMigrations(db);
  insertPublishedSubmission({
    id: 'submission-code-review-100',
    version: '1.0.0',
    publishedAt: '2026-05-24T10:05:00.000Z',
  });
  insertPublishedSubmission({
    id: 'submission-code-review-110',
    version: '1.1.0',
    publishedAt: '2026-05-25T10:05:00.000Z',
  });

  const app = createApp({ registry: { db } });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected AddressInfo from node:net for the test server');
  }

  vi.stubEnv('ASR_URL', `http://127.0.0.1:${(address as AddressInfo).port}`);
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  db?.close();
  vi.unstubAllEnvs();
});

describe('CLI listVersions against the live registry API', () => {
  it('resolves versions from GET /api/v1/skills/:owner/:name/versions', async () => {
    const versions = await cliListVersions('acme', 'code-review');

    expect(versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
  });
});

function insertPublishedSubmission(input: {
  id: string;
  version: string;
  publishedAt: string;
}): void {
  insertSubmission(db, {
    id: input.id,
    manifestJson: JSON.stringify({
      name: 'code-review',
      version: input.version,
      author: 'acme',
      description: 'Review code',
      tags: ['review'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    }),
    classification: 'md-only',
    contentHash: `sha256:${input.id}`,
    submittedAt: input.publishedAt,
    submittedBy: 'submitter@example.com',
    prNumber: 42,
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt: input.publishedAt,
      approvedBy: 'reviewer@example.com',
      mergeCommit: `merge-${input.id}`,
      skillMd: '# code-review',
    }),
  });
}
