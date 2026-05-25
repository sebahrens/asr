import type { Database } from '../db/index.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 100;

interface PublishLockOptions {
  timeoutMs?: number;
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function tryAcquirePublishLock(db: Database, skillName: string): boolean {
  const info = db
    .prepare('INSERT OR IGNORE INTO publish_locks (skill_name) VALUES (?)')
    .run(skillName);

  return info.changes === 1;
}

export function releasePublishLock(db: Database, skillName: string): void {
  db.prepare('DELETE FROM publish_locks WHERE skill_name = ?').run(skillName);
}

export async function withPublishLock<T>(
  db: Database,
  skillName: string,
  fn: () => Promise<T>,
  opts: PublishLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let delayMs = baseDelayMs;

  while (!tryAcquirePublishLock(db, skillName)) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new Error('publish_lock_timeout');
    }

    await sleep(Math.min(delayMs, remainingMs));
    delayMs *= 2;
  }

  try {
    return await fn();
  } finally {
    releasePublishLock(db, skillName);
  }
}
