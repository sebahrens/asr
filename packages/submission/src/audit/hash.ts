import { createHmac } from 'node:crypto';
import type { AuditEvent } from '@asr/core';

export const AUDIT_HASH_FORMAT_VERSION = 2;

export type HashableAuditEvent = Omit<AuditEvent, 'hash'> & {
  hashVersion: number;
};

export function computeHash(
  event: HashableAuditEvent,
  hmacKey: Buffer,
): string {
  const payload = [
    `v${event.hashVersion}`,
    event.id,
    event.submissionId ?? '',
    event.skillName ?? '',
    event.version ?? '',
    event.timestamp,
    event.actor,
    event.actorType,
    event.action,
    JSON.stringify(event.detail),
    event.prevHash,
    event.hmacKeyId,
  ].join('|');

  return createHmac('sha256', hmacKey).update(payload).digest('hex');
}
