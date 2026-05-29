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

function anchorTagName(now: Date): string {
  return `audit-anchor-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
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

  const tagName = anchorTagName(new Date());
  const message =
    `lastHash=${verified.lastHash}\n` +
    `eventCount=${verified.eventCount}\n` +
    `hmacKeyId=${verified.lastHmacKeyId}`;
  const signature = await signAnchorMessage(message, key);

  const targetSha = await forgejo.getDefaultBranchHeadSha();
  const { tagName: tn, commitSha } = await forgejo.createAnchorTag({
    tag: tagName,
    message,
    targetSha,
    signature,
  });

  db.transaction(() => {
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
