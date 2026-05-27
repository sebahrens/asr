import { describe, expect, it } from 'vitest';
import { SLA_POLICY, computeDeadline, nextAction } from './slaPolicy.js';

describe('slaPolicy', () => {
  it('encodes the workflow.md timeout-and-expiry table', () => {
    expect(SLA_POLICY.questionnaire).toEqual({
      timeoutDays: 7,
      firstExpiry: 'extend',
      extensionDays: 7,
    });
    expect(SLA_POLICY.confirmation).toEqual({
      timeoutDays: 14,
      firstExpiry: 'auto_reject',
      extensionDays: 0,
    });
    expect(SLA_POLICY.review).toEqual({
      timeoutDays: 30,
      firstExpiry: 'escalate',
      extensionDays: 7,
    });
  });

  it('drives each stage through its expiry policy', () => {
    expect(nextAction('questionnaire', false)).toBe('extend');
    expect(nextAction('questionnaire', true)).toBe('auto_reject');

    expect(nextAction('confirmation', false)).toBe('auto_reject');
    expect(nextAction('confirmation', true)).toBe('auto_reject');

    expect(nextAction('review', false)).toBe('escalate');
    expect(nextAction('review', true)).toBe('auto_reject');
  });

  it('computeDeadline adds timeoutDays on the first pass and extensionDays when extended', () => {
    const enteredAt = '2026-01-01T00:00:00Z';

    expect(computeDeadline('questionnaire', enteredAt).toISOString()).toBe(
      '2026-01-08T00:00:00.000Z',
    );
    expect(computeDeadline('questionnaire', enteredAt, true).toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );

    expect(computeDeadline('confirmation', enteredAt).toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(computeDeadline('confirmation', enteredAt, true).toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );

    expect(computeDeadline('review', enteredAt).toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(computeDeadline('review', enteredAt, true).toISOString()).toBe(
      '2026-02-07T00:00:00.000Z',
    );
  });

  it('computeDeadline rejects invalid ISO timestamps', () => {
    expect(() => computeDeadline('questionnaire', 'not-a-date')).toThrow(TypeError);
  });
});
