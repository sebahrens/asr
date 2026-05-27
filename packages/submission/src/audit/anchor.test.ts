import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as openpgp from 'openpgp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgejoClient } from '@asr/core';
import { runMigrations } from '../db/migrations/index.js';
import { emitAudit } from './emit.js';
import { runAnchorOnce } from './anchor.js';

const HMAC_KEY_BYTES = Buffer.alloc(32, 0x7a);
const HMAC_KEY_B64 = HMAC_KEY_BYTES.toString('base64');
const HMAC_KEY_ID = 'k-anchor-test';

const shouldRun = Boolean(process.env.FORGEJO_BASE_URL);

async function makeKey() {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519',
    userIDs: [{ name: 'ASR Anchor Test', email: 'anchor-test@example.invalid' }],
    format: 'object',
  });
  return privateKey;
}

function openTempDb(): { db: Database.Database; dbPath: string } {
  const dbPath = join(tmpdir(), `asr-anchor-${randomUUID()}.sqlite`);
  const db = new Database(dbPath);
  runMigrations(db);
  return { db, dbPath };
}

function seedEvents(db: Database.Database, count: number): void {
  for (let i = 0; i < count; i += 1) {
    emitAudit(db, {
      action: 'submission.created',
      actor: 'system',
      actorType: 'system',
      detail: { seq: i },
    });
  }
}

describe('runAnchorOnce (unit, mocked Forgejo)', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    const opened = openTempDb();
    db = opened.db;
    dbPath = opened.dbPath;
  });

  afterEach(() => {
    db?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    db = undefined;
    dbPath = undefined;

    if (originalKeyId === undefined) {
      delete process.env.AUDIT_HMAC_KEY_ID;
    } else {
      process.env.AUDIT_HMAC_KEY_ID = originalKeyId;
    }
    if (originalKeyBytes === undefined) {
      delete process.env.AUDIT_HMAC_KEY_BYTES;
    } else {
      process.env.AUDIT_HMAC_KEY_BYTES = originalKeyBytes;
    }
  });

  it('returns null and does not call Forgejo when there are no audit events', async () => {
    const database = db!;
    const key = await makeKey();

    const getDefaultBranchHeadSha = vi.fn();
    const createAnchorTag = vi.fn();
    const forgejo = {
      getDefaultBranchHeadSha,
      createAnchorTag,
    } as unknown as ForgejoClient;

    await expect(runAnchorOnce(database, forgejo, key)).resolves.toBeNull();

    expect(getDefaultBranchHeadSha).not.toHaveBeenCalled();
    expect(createAnchorTag).not.toHaveBeenCalled();
  });

  it('builds a signed message, tags the default branch head, and records audit.anchored', async () => {
    const database = db!;
    seedEvents(database, 3);

    const before = database
      .prepare('SELECT hash, hmac_key_id FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .get() as { hash: string; hmac_key_id: string };

    const key = await makeKey();
    const publicKey = key.toPublic();

    let signatureSeen: string | undefined;
    let messageSeen: string | undefined;
    const createAnchorTag = vi.fn(
      async (input: {
        tag: string;
        message: string;
        targetSha: string;
        signature?: string;
      }) => {
        signatureSeen = input.signature;
        messageSeen = input.message;
        return { tagName: input.tag, commitSha: input.targetSha };
      },
    );
    const getDefaultBranchHeadSha = vi.fn(async () => 'main-head-sha');

    const forgejo = {
      getDefaultBranchHeadSha,
      createAnchorTag,
    } as unknown as ForgejoClient;

    const result = await runAnchorOnce(database, forgejo, key);
    expect(result).not.toBeNull();
    expect(result!.eventCount).toBe(3);
    expect(result!.tagName).toMatch(/^audit-anchor-\d{8}T\d{6}Z$/);

    expect(getDefaultBranchHeadSha).toHaveBeenCalledTimes(1);
    expect(createAnchorTag).toHaveBeenCalledTimes(1);
    const callArg = createAnchorTag.mock.calls[0]![0];
    expect(callArg.targetSha).toBe('main-head-sha');
    expect(callArg.tag).toBe(result!.tagName);
    expect(messageSeen).toContain(`lastHash=${before.hash}`);
    expect(messageSeen).toContain('eventCount=3');
    expect(messageSeen).toContain(`hmacKeyId=${before.hmac_key_id}`);

    expect(signatureSeen).toBeTypeOf('string');
    expect(signatureSeen!.startsWith('-----BEGIN PGP SIGNATURE-----')).toBe(true);
    const verify = await openpgp.verify({
      message: await openpgp.createMessage({ text: messageSeen! }),
      signature: await openpgp.readSignature({ armoredSignature: signatureSeen! }),
      verificationKeys: publicKey,
    });
    await expect(verify.signatures[0]!.verified).resolves.toBe(true);

    const anchored = database
      .prepare(
        "SELECT detail, action FROM audit_events WHERE action = 'audit.anchored'",
      )
      .all() as Array<{ detail: string; action: string }>;
    expect(anchored).toHaveLength(1);
    const detail = JSON.parse(anchored[0]!.detail) as { tag: string; commitSha: string };
    expect(detail.tag).toBe(result!.tagName);
    expect(detail.commitSha).toBe('main-head-sha');
  });

  it('does not leak the GPG signature into the persisted audit row', async () => {
    const database = db!;
    seedEvents(database, 1);
    const key = await makeKey();

    const forgejo = {
      getDefaultBranchHeadSha: vi.fn(async () => 'sha'),
      createAnchorTag: vi.fn(async (input: { tag: string; targetSha: string }) => ({
        tagName: input.tag,
        commitSha: input.targetSha,
      })),
    } as unknown as ForgejoClient;

    await runAnchorOnce(database, forgejo, key);

    const rows = database
      .prepare("SELECT detail FROM audit_events WHERE action = 'audit.anchored'")
      .all() as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).not.toContain('BEGIN PGP SIGNATURE');
  });
});

describe.skipIf(!shouldRun)('runAnchorOnce (integration, dev Forgejo)', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const originalKeyId = process.env.AUDIT_HMAC_KEY_ID;
  const originalKeyBytes = process.env.AUDIT_HMAC_KEY_BYTES;

  beforeEach(() => {
    process.env.AUDIT_HMAC_KEY_ID = HMAC_KEY_ID;
    process.env.AUDIT_HMAC_KEY_BYTES = HMAC_KEY_B64;
    const opened = openTempDb();
    db = opened.db;
    dbPath = opened.dbPath;
  });

  afterEach(() => {
    db?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    db = undefined;
    dbPath = undefined;

    if (originalKeyId === undefined) {
      delete process.env.AUDIT_HMAC_KEY_ID;
    } else {
      process.env.AUDIT_HMAC_KEY_ID = originalKeyId;
    }
    if (originalKeyBytes === undefined) {
      delete process.env.AUDIT_HMAC_KEY_BYTES;
    } else {
      process.env.AUDIT_HMAC_KEY_BYTES = originalKeyBytes;
    }
  });

  it('creates a real Forgejo tag and records audit.anchored', async () => {
    const baseUrl = process.env.FORGEJO_BASE_URL!;
    const owner = process.env.FORGEJO_OWNER ?? 'asr';
    const repo = process.env.FORGEJO_REPO ?? 'skills';
    const token = process.env.FORGEJO_UPLOAD_TOKEN ?? process.env.FORGEJO_ADMIN_TOKEN ?? '';
    if (!token) {
      throw new Error('FORGEJO_BASE_URL set but no FORGEJO_UPLOAD_TOKEN/FORGEJO_ADMIN_TOKEN');
    }

    const { ForgejoClient } = await import('@asr/core');
    const forgejo = new ForgejoClient({
      baseUrl: baseUrl.endsWith('/api/v1') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/api/v1`,
      uploadToken: token,
      mergeToken: token,
      owner,
      repo,
      defaultBranch: 'main',
    });

    seedEvents(db!, 3);
    const key = await makeKey();

    const result = await runAnchorOnce(db!, forgejo, key);
    expect(result).not.toBeNull();
    expect(result!.tagName).toMatch(/^audit-anchor-\d{8}T\d{6}Z$/);
    expect(result!.eventCount).toBe(3);

    const rows = db!
      .prepare("SELECT detail FROM audit_events WHERE action = 'audit.anchored'")
      .all() as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail) as { tag: string; commitSha: string };
    expect(detail.tag).toBe(result!.tagName);
    expect(typeof detail.commitSha).toBe('string');
    expect(detail.commitSha.length).toBeGreaterThan(0);
  });
});
