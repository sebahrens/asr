import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from './index.js';
import type { AuditAction, AuditEvent } from './index.js';

describe('audit exports', () => {
  it('exports the closed audit action list and event type from the public entrypoint', () => {
    const action: AuditAction = 'audit.verify.failed';
    const event: AuditEvent = {
      id: 'evt_01',
      submissionId: null,
      skillName: null,
      version: null,
      timestamp: '2026-05-24T10:00:00.000Z',
      actor: 'system',
      actorType: 'system',
      action,
      detail: {},
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
      hmacKeyId: 'key_01',
    };

    expect(AUDIT_ACTIONS).toContain(event.action);
  });
});
