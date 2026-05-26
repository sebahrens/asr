import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@asr/core';
import { computeHash } from './hash.js';

const HMAC_KEY = Buffer.from('k'.repeat(32));

const sampleEventWithoutHash: Omit<AuditEvent, 'hash'> = {
  id: '01J0000000000000000000000A',
  submissionId: 'sub_123',
  skillName: 'example-skill',
  version: '1.2.3',
  timestamp: '2026-05-23T12:00:00.000Z',
  actor: 'user@example.com',
  actorType: 'user',
  action: 'submission.created',
  detail: { source: 'cli' },
  prevHash: '0'.repeat(64),
  hmacKeyId: 'k1',
};

describe('computeHash', () => {
  it('returns a 64-char lowercase hex string', () => {
    const digest = computeHash(sampleEventWithoutHash, HMAC_KEY);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across two calls with the same inputs', () => {
    const a = computeHash(sampleEventWithoutHash, HMAC_KEY);
    const b = computeHash(sampleEventWithoutHash, HMAC_KEY);
    expect(a).toBe(b);
  });

  it('changes when event.detail changes', () => {
    const a = computeHash(sampleEventWithoutHash, HMAC_KEY);
    const b = computeHash(
      { ...sampleEventWithoutHash, detail: { source: 'web' } },
      HMAC_KEY,
    );
    expect(a).not.toBe(b);
  });

  it('serialises null submissionId/skillName/version to empty-string payload segments', () => {
    const nullEvent: Omit<AuditEvent, 'hash'> = {
      ...sampleEventWithoutHash,
      submissionId: null,
      skillName: null,
      version: null,
    };

    const expectedPayload = [
      nullEvent.id,
      '',
      '',
      '',
      nullEvent.timestamp,
      nullEvent.actor,
      nullEvent.action,
      JSON.stringify(nullEvent.detail),
      nullEvent.prevHash,
    ].join('|');
    const expectedDigest = createHmac('sha256', HMAC_KEY)
      .update(expectedPayload)
      .digest('hex');

    expect(computeHash(nullEvent, HMAC_KEY)).toBe(expectedDigest);
  });
});
