import type Database from 'better-sqlite3';

export interface PrincipalInput {
  sub: string;
  email: string;
  displayName: string;
}

export interface PrincipalView {
  email: string;
  displayName: string;
}

interface PrincipalRow {
  email: string | null;
  display_name: string | null;
}

/**
 * Insert or refresh a principals row for the given Entra `sub`.
 *
 * `first_seen` is only set on initial insert; `last_seen` is always bumped to
 * the current ISO 8601 UTC timestamp. `email` and `display_name` are
 * overwritten by the incoming values on every call so renames propagate.
 *
 * Audit rows reference only the opaque `sub`; this table is the only place
 * PII lives and is purgeable per GDPR Article 17 (specs/audit.md#retention--gdpr).
 */
export function upsertPrincipal(
  db: Database.Database,
  p: PrincipalInput,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO principals (sub, email, display_name, first_seen, last_seen)
      VALUES (@sub, @email, @displayName, @now, @now)
      ON CONFLICT(sub) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        last_seen = excluded.last_seen
    `,
  ).run({ sub: p.sub, email: p.email, displayName: p.displayName, now });
}

/**
 * Look up the email/displayName for an Entra `sub`. Returns `null` when the
 * principal is unknown or has been purged (row absent, or columns nulled).
 */
export function getPrincipal(
  db: Database.Database,
  sub: string,
): PrincipalView | null {
  const row = db
    .prepare('SELECT email, display_name FROM principals WHERE sub = ?')
    .get(sub) as PrincipalRow | undefined;

  if (!row) return null;
  if (row.email === null || row.display_name === null) return null;

  return { email: row.email, displayName: row.display_name };
}

/**
 * GDPR Article 17 erasure: delete the principals row for `sub`. Returns true
 * if a row was deleted, false if no such principal existed.
 *
 * MUST NOT touch `audit_events` — audit immutability is a SOC 2 / SOX
 * requirement (specs/audit.md line 177). The chain stays intact because the
 * audit rows only reference the opaque `sub`, never the email or display
 * name.
 */
export function purgePrincipal(db: Database.Database, sub: string): boolean {
  const result = db.prepare('DELETE FROM principals WHERE sub = ?').run(sub);
  return result.changes > 0;
}
