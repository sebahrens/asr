import { createHmac } from 'node:crypto';
import type { AuditEvent } from '@asr/core';

export function computeHash(
  event: Omit<AuditEvent, 'hash'>,
  hmacKey: Buffer,
): string {
  const payload = [
    event.id,
    event.submissionId ?? '',
    event.skillName ?? '',
    event.version ?? '',
    event.timestamp,
    event.actor,
    event.action,
    JSON.stringify(event.detail),
    event.prevHash,
  ].join('|');

  return createHmac('sha256', hmacKey).update(payload).digest('hex');
}
