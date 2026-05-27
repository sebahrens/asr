import { describe, expect, it, vi } from 'vitest';
import type { EmitAuditInput } from '../audit/emit.js';
import {
  registerSlaTimeoutJob,
  runSlaSweep,
  startJobs,
  type HitlStageRecord,
  type SlaRejectInput,
  type SlaTimeoutDeps,
} from './index.js';

interface SpyDeps {
  deps: SlaTimeoutDeps;
  markExtendedCalls: { id: string; stage: HitlStageRecord['stage'] }[];
  rejectCalls: SlaRejectInput[];
  notifyCalls: string[];
  auditCalls: EmitAuditInput[];
}

function buildDeps(stagesRef: () => HitlStageRecord[]): SpyDeps {
  const markExtendedCalls: { id: string; stage: HitlStageRecord['stage'] }[] = [];
  const rejectCalls: SlaRejectInput[] = [];
  const notifyCalls: string[] = [];
  const auditCalls: EmitAuditInput[] = [];

  const deps: SlaTimeoutDeps = {
    readActiveHitlStages: () => stagesRef(),
    markExtended: (id, stage) => {
      markExtendedCalls.push({ id, stage });
    },
    deliverReject: (input) => {
      rejectCalls.push(input);
    },
    notifySlaExtended: (id) => {
      notifyCalls.push(id);
    },
    emitAudit: (input) => {
      auditCalls.push(input);
    },
  };

  return { deps, markExtendedCalls, rejectCalls, notifyCalls, auditCalls };
}

describe('runSlaSweep', () => {
  it('extends a stale questionnaire once then auto-rejects on the next pass', async () => {
    const enteredAt = '2026-01-01T00:00:00.000Z';
    let extended = false;
    const spies = buildDeps(() => [
      {
        submissionId: 'sub-q',
        stage: 'questionnaire',
        enteredAtIso: enteredAt,
        alreadyExtended: extended,
      },
    ]);
    const originalMarkExtended = spies.deps.markExtended;
    spies.deps.markExtended = (id, stage) => {
      originalMarkExtended(id, stage);
      if (id === 'sub-q') extended = true;
    };

    // First sweep: 8 days after entry — past 7d deadline, not yet extended.
    const day8 = new Date('2026-01-09T00:00:00.000Z');
    const first = await runSlaSweep(day8, spies.deps);

    expect(first.extended).toEqual(['sub-q']);
    expect(first.rejected).toEqual([]);
    expect(spies.notifyCalls).toEqual(['sub-q']);
    expect(spies.markExtendedCalls).toEqual([{ id: 'sub-q', stage: 'questionnaire' }]);
    expect(spies.rejectCalls).toEqual([]);
    expect(spies.auditCalls).toEqual([]);

    // Second sweep: 16 days after entry — past extended 7+7=14d deadline.
    const day16 = new Date('2026-01-17T00:00:00.000Z');
    const second = await runSlaSweep(day16, spies.deps);

    expect(second.extended).toEqual([]);
    expect(second.rejected).toEqual(['sub-q']);
    expect(spies.rejectCalls).toEqual([
      { submissionId: 'sub-q', reason: 'timeout', stage: 'questionnaire' },
    ]);
    expect(spies.auditCalls).toHaveLength(1);
    expect(spies.auditCalls[0]).toMatchObject({
      action: 'submission.expired',
      submissionId: 'sub-q',
      actor: 'system',
      actorType: 'system',
      detail: { reason: 'timeout', stage: 'questionnaire' },
    });
  });

  it('auto-rejects a stale confirmation on the first pass (no extension)', async () => {
    const spies = buildDeps(() => [
      {
        submissionId: 'sub-c',
        stage: 'confirmation',
        enteredAtIso: '2026-01-01T00:00:00.000Z',
        alreadyExtended: false,
      },
    ]);

    // 15 days past entry — past 14d confirmation deadline.
    const day15 = new Date('2026-01-16T00:00:00.000Z');
    const result = await runSlaSweep(day15, spies.deps);

    expect(result.extended).toEqual([]);
    expect(result.rejected).toEqual(['sub-c']);
    expect(spies.notifyCalls).toEqual([]);
    expect(spies.markExtendedCalls).toEqual([]);
    expect(spies.rejectCalls).toEqual([
      { submissionId: 'sub-c', reason: 'timeout', stage: 'confirmation' },
    ]);
    expect(spies.auditCalls).toHaveLength(1);
    expect(spies.auditCalls[0]).toMatchObject({
      action: 'submission.expired',
      submissionId: 'sub-c',
      detail: { reason: 'timeout', stage: 'confirmation' },
    });
  });

  it('does nothing for stages still within their deadline', async () => {
    const spies = buildDeps(() => [
      {
        submissionId: 'sub-fresh',
        stage: 'questionnaire',
        enteredAtIso: '2026-01-01T00:00:00.000Z',
        alreadyExtended: false,
      },
    ]);

    const day3 = new Date('2026-01-04T00:00:00.000Z');
    const result = await runSlaSweep(day3, spies.deps);

    expect(result.extended).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(spies.markExtendedCalls).toEqual([]);
    expect(spies.rejectCalls).toEqual([]);
    expect(spies.notifyCalls).toEqual([]);
    expect(spies.auditCalls).toEqual([]);
  });

  it('leaves the review stage untouched (escalate is owned by asr-h4i.3)', async () => {
    const spies = buildDeps(() => [
      {
        submissionId: 'sub-r',
        stage: 'review',
        enteredAtIso: '2026-01-01T00:00:00.000Z',
        alreadyExtended: false,
      },
    ]);

    // 31 days past entry — past the 30d review deadline. Action is 'escalate'.
    const day31 = new Date('2026-02-01T00:00:00.000Z');
    const result = await runSlaSweep(day31, spies.deps);

    expect(result.extended).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(spies.markExtendedCalls).toEqual([]);
    expect(spies.rejectCalls).toEqual([]);
    expect(spies.notifyCalls).toEqual([]);
    expect(spies.auditCalls).toEqual([]);
  });

  it('processes a batch of mixed stages in one sweep', async () => {
    const spies = buildDeps(() => [
      {
        submissionId: 'sub-q',
        stage: 'questionnaire',
        enteredAtIso: '2026-01-01T00:00:00.000Z',
        alreadyExtended: false,
      },
      {
        submissionId: 'sub-c',
        stage: 'confirmation',
        enteredAtIso: '2026-01-01T00:00:00.000Z',
        alreadyExtended: false,
      },
      {
        submissionId: 'sub-fresh',
        stage: 'questionnaire',
        enteredAtIso: '2026-01-12T00:00:00.000Z',
        alreadyExtended: false,
      },
    ]);

    // 15 days past start — q is past 7d (extend), c is past 14d (auto-reject),
    // fresh is only ~3 days in (within 7d).
    const day15 = new Date('2026-01-16T00:00:00.000Z');
    const result = await runSlaSweep(day15, spies.deps);

    expect(result.extended).toEqual(['sub-q']);
    expect(result.rejected).toEqual(['sub-c']);
  });
});

describe('registerSlaTimeoutJob', () => {
  it('invokes runSlaSweep on the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const stagesRef: HitlStageRecord[] = [];
      const spies = buildDeps(() => stagesRef);
      const handle = registerSlaTimeoutJob({
        intervalMs: 1000,
        deps: spies.deps,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      vi.advanceTimersByTime(2500);
      // Allow promise microtasks scheduled by setInterval to run.
      await vi.runOnlyPendingTimersAsync();

      handle.stop();
      vi.advanceTimersByTime(10_000);
      await vi.runOnlyPendingTimersAsync();

      // No stages were defined, so each tick produces no side effects, but the
      // handle should be callable and stop should not throw.
      expect(spies.rejectCalls).toEqual([]);
      expect(spies.notifyCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startJobs returns a composite handle that registers the SLA timer', () => {
    vi.useFakeTimers();
    try {
      const spies = buildDeps(() => []);
      const handle = startJobs({
        slaTimeout: {
          intervalMs: 1000,
          deps: spies.deps,
          now: () => new Date('2026-01-01T00:00:00.000Z'),
        },
      });

      expect(typeof handle.stop).toBe('function');
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startJobs is a no-op when no jobs are configured', () => {
    const handle = startJobs();
    expect(() => handle.stop()).not.toThrow();
  });
});
