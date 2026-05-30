import type Database from 'better-sqlite3';
import type { PrivateKey } from 'openpgp';
import type { ForgejoClient } from '@asr/core';
import { runAnchorOnce, type AnchorResult } from './anchor.js';
import type { KeyRing } from './keyring.js';

export interface ShouldAnchorState {
  lastAnchorAt: number;
  lastAnchorEventCount: number;
  now: number;
  currentEventCount: number;
}

export interface ShouldAnchorOpts {
  intervalMs: number;
  eventThreshold: number;
}

export function shouldAnchor(
  state: ShouldAnchorState,
  opts: ShouldAnchorOpts,
): boolean {
  const elapsed = state.now - state.lastAnchorAt;
  const newEvents = state.currentEventCount - state.lastAnchorEventCount;
  return elapsed >= opts.intervalMs || newEvents >= opts.eventThreshold;
}

export interface AnchorSchedulerOpts {
  db: Database.Database;
  forgejo: ForgejoClient;
  key: PrivateKey;
  keys: KeyRing;
  intervalMs?: number;
  eventThreshold?: number;
  pollMs?: number;
  now?: () => number;
  run?: typeof runAnchorOnce;
  log?: (message: string, error?: unknown) => void;
}

export interface AnchorSchedulerState {
  readonly lastAnchorAt: number;
  readonly lastAnchorEventCount: number;
}

export interface AnchorSchedulerHandle {
  start(): void;
  stop(): void;
  tick(): Promise<AnchorResult | null>;
  getState(): AnchorSchedulerState;
}

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_EVENT_THRESHOLD = 100;
const DEFAULT_POLL_MS = 60_000;

function countEvents(db: Database.Database): number {
  return db.prepare('SELECT COUNT(*) FROM audit_events').pluck().get() as number;
}

function countEventsThroughRowid(
  db: Database.Database,
  rowid: number,
): number {
  return db
    .prepare('SELECT COUNT(*) FROM audit_events WHERE rowid <= ?')
    .pluck()
    .get(rowid) as number;
}

function parseAuditTimestamp(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadInitialAnchorState(
  db: Database.Database,
  now: () => number,
): AnchorSchedulerState {
  const latestAnchor = db
    .prepare(
      `
        SELECT rowid AS anchor_rowid, timestamp
        FROM audit_events
        WHERE action = 'audit.anchored'
        ORDER BY rowid DESC
        LIMIT 1
      `,
    )
    .get() as { anchor_rowid: number; timestamp: string } | undefined;

  if (latestAnchor) {
    return {
      lastAnchorAt: parseAuditTimestamp(latestAnchor.timestamp) ?? now(),
      lastAnchorEventCount: countEventsThroughRowid(
        db,
        latestAnchor.anchor_rowid,
      ),
    };
  }

  const firstEventTimestamp = db
    .prepare('SELECT MIN(timestamp) FROM audit_events')
    .pluck()
    .get() as string | null;

  return {
    lastAnchorAt: parseAuditTimestamp(firstEventTimestamp) ?? now(),
    lastAnchorEventCount: 0,
  };
}

export function createAnchorScheduler(
  opts: AnchorSchedulerOpts,
): AnchorSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const eventThreshold = opts.eventThreshold ?? DEFAULT_EVENT_THRESHOLD;
  const pollMs = opts.pollMs ?? Math.min(intervalMs, DEFAULT_POLL_MS);
  const now = opts.now ?? Date.now;
  const run = opts.run ?? runAnchorOnce;

  const initialState = loadInitialAnchorState(opts.db, now);
  let lastAnchorAt = initialState.lastAnchorAt;
  let lastAnchorEventCount = initialState.lastAnchorEventCount;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<AnchorResult | null> {
    if (running) return null;
    running = true;
    try {
      const currentEventCount = countEvents(opts.db);
      const trigger = shouldAnchor(
        { lastAnchorAt, lastAnchorEventCount, now: now(), currentEventCount },
        { intervalMs, eventThreshold },
      );
      if (!trigger) return null;

      const result = await run(opts.db, opts.forgejo, opts.key, opts.keys);
      lastAnchorAt = now();
      lastAnchorEventCount = countEvents(opts.db);
      return result;
    } catch (err) {
      opts.log?.('anchor scheduler tick failed', err);
      return null;
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, pollMs);
    (timer as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    start,
    stop,
    tick,
    getState() {
      return { lastAnchorAt, lastAnchorEventCount };
    },
  };
}
