import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import {
  releasePublishLock,
  tryAcquirePublishLock,
  withPublishLock,
} from './publishLock.js';

describe('publish locks', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function openMigratedDatabase(): Database.Database {
    db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  it('acquires each per-skill publish lock once until released', () => {
    const database = openMigratedDatabase();

    expect(tryAcquirePublishLock(database, 'demo')).toBe(true);
    expect(tryAcquirePublishLock(database, 'demo')).toBe(false);

    releasePublishLock(database, 'demo');

    expect(tryAcquirePublishLock(database, 'demo')).toBe(true);
  });

  it('times out while a publish lock is held', async () => {
    const database = openMigratedDatabase();

    expect(tryAcquirePublishLock(database, 'demo')).toBe(true);

    await expect(
      withPublishLock(database, 'demo', async () => undefined, {
        timeoutMs: 50,
        baseDelayMs: 10,
      }),
    ).rejects.toThrow(/publish_lock_timeout/);

    releasePublishLock(database, 'demo');

    expect(tryAcquirePublishLock(database, 'demo')).toBe(true);
  });

  it('releases the publish lock after the protected function rejects', async () => {
    const database = openMigratedDatabase();

    await expect(
      withPublishLock(database, 'demo', async () => {
        throw new Error('publish failed');
      }),
    ).rejects.toThrow(/publish failed/);

    expect(tryAcquirePublishLock(database, 'demo')).toBe(true);
  });
});
