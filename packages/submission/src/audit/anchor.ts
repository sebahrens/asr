import type Database from 'better-sqlite3';
import type { PrivateKey } from 'openpgp';
import type { ForgejoClient } from '@asr/core';
import { signAnchorMessage } from './anchor-signer.js';
import { emitAudit } from './emit.js';
import type { KeyRing } from './keyring.js';
import { verifyChain } from './verify.js';

export interface AnchorResult {
  tagName: string;
  eventCount: number;
}

interface AnchorIntent {
  tag_name: string;
  target_sha: string;
  status: 'pending' | 'anchored';
}

function anchorTagName(lastHash: string, eventCount: number): string {
  return `audit-anchor-${lastHash.slice(0, 16)}-${eventCount}`;
}

function upsertPendingIntent(
  db: Database.Database,
  input: {
    tagName: string;
    lastHash: string;
    eventCount: number;
    hmacKeyId: string;
    targetSha: string;
  },
): AnchorIntent {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO audit_anchor_intents (
        tag_name,
        last_hash,
        event_count,
        hmac_key_id,
        target_sha,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(tag_name) DO NOTHING
    `,
  ).run(
    input.tagName,
    input.lastHash,
    input.eventCount,
    input.hmacKeyId,
    input.targetSha,
    now,
    now,
  );

  return db
    .prepare(
      `
        SELECT tag_name, target_sha, status
        FROM audit_anchor_intents
        WHERE tag_name = ?
      `,
    )
    .get(input.tagName) as AnchorIntent;
}

export async function runAnchorOnce(
  db: Database.Database,
  forgejo: ForgejoClient,
  key: PrivateKey,
  keys: KeyRing,
): Promise<AnchorResult | null> {
  const verified = verifyChain(db, keys);
  if (!verified.valid) {
    const lastAction = db
      .prepare('SELECT action FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .pluck()
      .get() as string | undefined;

    if (lastAction !== 'audit.verify.failed') {
      emitAudit(
        db,
        {
          action: 'audit.verify.failed',
          actor: 'system',
          actorType: 'system',
          detail: { brokenAt: verified.brokenAt, reason: verified.reason },
        },
        keys,
      );
    }
    return null;
  }

  if (verified.eventCount === 0) {
    return null;
  }
  if (!verified.lastHmacKeyId) {
    throw new Error('verified audit chain has events but no last HMAC key id');
  }

  const tagName = anchorTagName(verified.lastHash, verified.eventCount);
  const message =
    `lastHash=${verified.lastHash}\n` +
    `eventCount=${verified.eventCount}\n` +
    `hmacKeyId=${verified.lastHmacKeyId}`;
  const signature = await signAnchorMessage(message, key);

  const existingIntent = db
    .prepare(
      `
        SELECT tag_name, target_sha, status
        FROM audit_anchor_intents
        WHERE tag_name = ?
      `,
    )
    .get(tagName) as AnchorIntent | undefined;
  const targetSha = existingIntent?.target_sha ?? (await forgejo.getDefaultBranchHeadSha());
  const intent = upsertPendingIntent(db, {
    tagName,
    lastHash: verified.lastHash,
    eventCount: verified.eventCount,
    hmacKeyId: verified.lastHmacKeyId,
    targetSha,
  });

  if (intent.status === 'anchored') {
    return { tagName: intent.tag_name, eventCount: verified.eventCount };
  }

  const { tagName: tn, commitSha } = await forgejo.createAnchorTag({
    tag: tagName,
    message,
    targetSha: intent.target_sha,
    signature,
  });

  db.transaction(() => {
    db.prepare(
      `
        UPDATE audit_anchor_intents
        SET status = 'anchored',
            commit_sha = ?,
            updated_at = ?
        WHERE tag_name = ?
      `,
    ).run(commitSha, new Date().toISOString(), tn);

    emitAudit(
      db,
      {
        action: 'audit.anchored',
        actor: 'system',
        actorType: 'system',
        detail: { tag: tn, commitSha },
      },
      keys,
    );
  })();

  return { tagName: tn, eventCount: verified.eventCount };
}
