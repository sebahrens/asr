import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations, runMigrations, type Migration } from './index.js';

describe('runMigrations', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;
  const baseMigrationCount = migrations.length;

  afterEach(() => {
    migrations.length = baseMigrationCount;
    db?.close();

    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }

    db = undefined;
    dbPath = undefined;
  });

  it('applies each migration only once', () => {
    const testMigrationId = 999_001;
    let appliedCount = 0;
    const testMigration: Migration = {
      id: testMigrationId,
      name: 'test_idempotent_migration',
      up(database) {
        appliedCount += 1;
        database.exec('CREATE TABLE test_migration_marker (id INTEGER PRIMARY KEY)');
      },
    };

    migrations.push(testMigration);
    dbPath = join(tmpdir(), `asr-migrations-${randomUUID()}.sqlite`);
    db = new Database(dbPath);

    runMigrations(db);
    runMigrations(db);

    const migrationRows = db
      .prepare('SELECT COUNT(*) FROM schema_migrations WHERE id = ?')
      .pluck()
      .get(testMigrationId);

    expect(migrationRows).toBe(1);
    expect(appliedCount).toBe(1);
  });
});
