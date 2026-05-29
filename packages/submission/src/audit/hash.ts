import { createHmac } from 'node:crypto';
import type { AuditEvent } from '@asr/core';

export const AUDIT_HASH_FORMAT_VERSION = 3;

export type HashableAuditEvent = Omit<AuditEvent, 'hash'> & {
  hashVersion: number;
};

export function computeHash(
  event: HashableAuditEvent,
  hmacKey: Buffer,
): string {
  const hmac = createHmac('sha256', hmacKey);

  updateString(hmac, `v${event.hashVersion}`);
  updateString(hmac, event.id);
  updateNullableString(hmac, event.submissionId);
  updateNullableString(hmac, event.skillName);
  updateNullableString(hmac, event.version);
  updateString(hmac, event.timestamp);
  updateString(hmac, event.actor);
  updateString(hmac, event.actorType);
  updateString(hmac, event.action);
  updateString(hmac, JSON.stringify(event.detail));
  updateString(hmac, event.prevHash);
  updateString(hmac, event.hmacKeyId);

  return hmac.digest('hex');
}

function updateNullableString(
  hmac: ReturnType<typeof createHmac>,
  value: string | null,
): void {
  if (value === null) {
    hmac.update(Buffer.from([0]));
    return;
  }

  hmac.update(Buffer.from([1]));
  updateString(hmac, value);
}

function updateString(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  hmac.update(length);
  hmac.update(bytes);
}
