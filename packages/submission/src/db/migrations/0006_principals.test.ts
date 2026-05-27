import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';

interface PragmaColumn {
  name: string;
  pk: number;
}

interface PragmaIndex {
  name: string;
}

describe('migration0006Principals', () => {
  let db: Database.Database | undefined;
  let dbPath: string | undefined;

  afterEach(() => {
    db?.close();

    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }

    db = undefined;
    dbPath = undefined;
  });

  function openDatabase(): Database.Database {
    dbPath = join(tmpdir(), `asr-principals-migration-${randomUUID()}.sqlite`);
    db = new Database(dbPath);
    return db;
  }

  it('creates the principals table with sub as the primary key', () => {
    const database = openDatabase();

    runMigrations(database);

    const columns = database.pragma('table_info(principals)') as PragmaColumn[];

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['sub', 'email', 'display_name', 'first_seen', 'last_seen']),
    );

    const primaryKey = columns.find((column) => column.pk === 1);
    expect(primaryKey?.name).toBe('sub');
  });

  it('creates the idx_principals_email index', () => {
    const database = openDatabase();

    runMigrations(database);

    const indexes = (database.pragma('index_list(principals)') as PragmaIndex[]).map(
      (index) => index.name,
    );

    expect(indexes).toEqual(expect.arrayContaining(['idx_principals_email']));
  });

  it('enforces sub uniqueness as the primary key', () => {
    const database = openDatabase();

    runMigrations(database);

    const insertPrincipal = database.prepare(`
      INSERT INTO principals (sub, email, display_name, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertPrincipal.run(
      'entra-sub-1',
      'user@example.com',
      'User Example',
      '2026-05-24T00:00:00.000Z',
      '2026-05-24T00:00:00.000Z',
    );

    expect(() => {
      insertPrincipal.run(
        'entra-sub-1',
        'duplicate@example.com',
        'Duplicate User',
        '2026-05-24T00:00:01.000Z',
        '2026-05-24T00:00:01.000Z',
      );
    }).toThrow();
  });

  it('allows null email and display_name (purged principal)', () => {
    const database = openDatabase();

    runMigrations(database);

    const insertPrincipal = database.prepare(`
      INSERT INTO principals (sub, email, display_name, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
    `);

    expect(() => {
      insertPrincipal.run(
        'entra-sub-purged',
        null,
        null,
        '2026-05-24T00:00:00.000Z',
        '2026-05-24T00:00:00.000Z',
      );
    }).not.toThrow();
  });
});
