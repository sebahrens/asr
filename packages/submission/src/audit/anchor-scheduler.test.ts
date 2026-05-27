import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgejoClient } from '@asr/core';
import type { PrivateKey } from 'openpgp';
import type { AnchorResult } from './anchor.js';
import {
  createAnchorScheduler,
  shouldAnchor,
} from './anchor-scheduler.js';

function openTempDb(initialEvents = 0): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  const insert = db.prepare('INSERT INTO audit_events DEFAULT VALUES');
  for (let i = 0; i < initialEvents; i += 1) insert.run();
  return db;
}

function addEvents(db: Database.Database, count: number): void {
  const insert = db.prepare('INSERT INTO audit_events DEFAULT VALUES');
  for (let i = 0; i < count; i += 1) insert.run();
}

const stubForgejo = {} as unknown as ForgejoClient;
const stubKey = {} as unknown as PrivateKey;

describe('shouldAnchor', () => {
  const baseOpts = { intervalMs: 3_600_000, eventThreshold: 100 };

  it('returns true when 100 new events have accumulated, even with small elapsed time', () => {
    expect(
      shouldAnchor(
        {
          lastAnchorAt: 1_000,
          lastAnchorEventCount: 0,
          now: 2_000, // only 1s elapsed
          currentEventCount: 100,
        },
        baseOpts,
      ),
    ).toBe(true);
  });

  it('returns true when an hour has elapsed even with 0 new events', () => {
    expect(
      shouldAnchor(
        {
          lastAnchorAt: 0,
          lastAnchorEventCount: 50,
          now: 3_600_000,
          currentEventCount: 50,
        },
        baseOpts,
      ),
    ).toBe(true);
  });

  it('returns false when both elapsed time and new-event count are below threshold', () => {
    expect(
      shouldAnchor(
        {
          lastAnchorAt: 0,
          lastAnchorEventCount: 0,
          now: 60_000, // 1 minute
          currentEventCount: 50, // 50 new events
        },
        baseOpts,
      ),
    ).toBe(false);
  });

  it('treats the threshold boundary as inclusive', () => {
    expect(
      shouldAnchor(
        {
          lastAnchorAt: 0,
          lastAnchorEventCount: 7,
          now: 0,
          currentEventCount: 107,
        },
        { intervalMs: 3_600_000, eventThreshold: 100 },
      ),
    ).toBe(true);
  });
});

describe('createAnchorScheduler', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = openTempDb(0);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('invokes run when the event threshold is crossed and advances lastAnchorEventCount', async () => {
    const database = db!;

    let currentTime = 0;
    const run = vi.fn(
      async (
        _db: Database.Database,
        _forgejo: ForgejoClient,
        _key: PrivateKey,
      ): Promise<AnchorResult | null> => {
        addEvents(database, 1); // emulate runAnchorOnce inserting audit.anchored
        return { tagName: 'audit-anchor-test', eventCount: 100 };
      },
    );

    const scheduler = createAnchorScheduler({
      db: database,
      forgejo: stubForgejo,
      key: stubKey,
      intervalMs: 3_600_000,
      eventThreshold: 100,
      now: () => currentTime,
      run,
    });

    const stateBefore = scheduler.getState();
    expect(stateBefore.lastAnchorEventCount).toBe(0);
    expect(stateBefore.lastAnchorAt).toBe(0);

    addEvents(database, 100);
    currentTime = 1_000; // only 1 second elapsed; threshold reached via events
    const result = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(database, stubForgejo, stubKey);
    expect(result).toEqual({ tagName: 'audit-anchor-test', eventCount: 100 });

    const stateAfter = scheduler.getState();
    expect(stateAfter.lastAnchorAt).toBe(1_000);
    // 100 seeded + 1 anchor row emulated by the spy = 101
    expect(stateAfter.lastAnchorEventCount).toBe(101);
  });

  it('skips run when neither the time interval nor the event threshold is crossed', async () => {
    const database = db!;

    let currentTime = 0;
    const run = vi.fn(async () => ({ tagName: 't', eventCount: 5 }));

    const scheduler = createAnchorScheduler({
      db: database,
      forgejo: stubForgejo,
      key: stubKey,
      intervalMs: 3_600_000,
      eventThreshold: 100,
      now: () => currentTime,
      run,
    });

    addEvents(database, 5);
    currentTime = 60_000; // 1 minute later; only 5 new events (well under 100)
    const result = await scheduler.tick();

    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.getState().lastAnchorEventCount).toBe(0);
  });

  it('invokes run when the time interval is crossed even with no new events', async () => {
    const database = db!;
    let currentTime = 0;
    const run = vi.fn(async () => null); // no events to anchor

    const scheduler = createAnchorScheduler({
      db: database,
      forgejo: stubForgejo,
      key: stubKey,
      intervalMs: 3_600_000,
      eventThreshold: 100,
      now: () => currentTime,
      run,
    });

    currentTime = 3_600_000;
    await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getState().lastAnchorAt).toBe(3_600_000);
  });

  it('start() polls on the configured pollMs and stop() halts further ticks', async () => {
    vi.useFakeTimers();
    try {
      const database = db!;

      let currentTime = 0;
      const run = vi.fn(async () => {
        addEvents(database, 1);
        return { tagName: 't', eventCount: 100 };
      });

      const scheduler = createAnchorScheduler({
        db: database,
        forgejo: stubForgejo,
        key: stubKey,
        intervalMs: 3_600_000,
        eventThreshold: 100,
        pollMs: 1_000,
        now: () => currentTime,
        run,
      });

      addEvents(database, 100);
      scheduler.start();
      currentTime = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(run).toHaveBeenCalledTimes(1);

      scheduler.stop();
      currentTime = 10_000;
      await vi.advanceTimersByTimeAsync(10_000);

      // No further invocations after stop.
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() is idempotent', () => {
    const scheduler = createAnchorScheduler({
      db: db!,
      forgejo: stubForgejo,
      key: stubKey,
      run: vi.fn(async () => null),
      pollMs: 1_000,
    });
    scheduler.start();
    scheduler.start(); // should not throw or schedule a second timer
    scheduler.stop();
  });

  it('swallows errors from run via the log hook', async () => {
    const database = db!;

    let currentTime = 0;
    const log = vi.fn();
    const error = new Error('boom');
    const run = vi.fn(async () => {
      throw error;
    });

    const scheduler = createAnchorScheduler({
      db: database,
      forgejo: stubForgejo,
      key: stubKey,
      intervalMs: 3_600_000,
      eventThreshold: 100,
      now: () => currentTime,
      run,
      log,
    });

    addEvents(database, 100);
    currentTime = 1_000;
    const result = await scheduler.tick();

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toBe(error);
  });
});
