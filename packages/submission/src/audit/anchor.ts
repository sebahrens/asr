import type Database from 'better-sqlite3';
import type { PrivateKey } from 'openpgp';
import type { ForgejoClient } from '@asr/core';
import { signAnchorMessage } from './anchor-signer.js';
import { emitAudit } from './emit.js';

export interface AnchorResult {
  tagName: string;
  eventCount: number;
}

interface HeadRow {
  hash: string;
  hmac_key_id: string;
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
): Promise<AnchorResult | null> {
  const eventCount = db
    .prepare('SELECT COUNT(*) FROM audit_events')
    .pluck()
    .get() as number;
  if (eventCount === 0) {
    return null;
  }

  const headRow = db
    .prepare('SELECT hash, hmac_key_id FROM audit_events ORDER BY rowid DESC LIMIT 1')
    .get() as HeadRow;

  const tagName = anchorTagName(new Date());
  const message =
    `lastHash=${headRow.hash}\n` +
    `eventCount=${eventCount}\n` +
    `hmacKeyId=${headRow.hmac_key_id}`;
  const signature = await signAnchorMessage(message, key);

  const targetSha = await forgejo.getDefaultBranchHeadSha();
  const { tagName: tn, commitSha } = await forgejo.createAnchorTag({
    tag: tagName,
    message,
    targetSha,
    signature,
  });

  db.transaction(() => {
    emitAudit(db, {
      action: 'audit.anchored',
      actor: 'system',
      actorType: 'system',
      detail: { tag: tn, commitSha },
    });
  })();

  return { tagName: tn, eventCount };
}
