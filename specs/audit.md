# Audit Trail

## Design Principles

1. **Immutable** — events are append-only; no updates, no deletes.
2. **Tamper-evident** — HMAC hash chaining + periodic Git-tag anchoring detect any modification.
3. **Queryable** — structured SQLite table indexed for the dashboards the compliance team actually uses ("show me everything that happened to skill X", "show me everything user Y did this quarter").
4. **Dual-layer** — DB for operational queries, Git history for durable provenance, scan reports stored as artefacts in `reviews/{owner}/{skill}/v{version}-scan.json`.
5. **Replayable** — given the Git history alone, the `skill_versions`, `version_diffs`, and `audit_events` tables can be rebuilt from scratch.

## Schema

```sql
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,        -- ULID (time-sortable)
  submission_id   TEXT,                    -- nullable: some events (yanks, periodic re-scans) have no submission
  skill_name      TEXT,                    -- denormalised for fast per-skill queries
  version         TEXT,                    -- denormalised for fast per-version queries
  timestamp       TEXT NOT NULL,           -- ISO 8601 UTC
  actor           TEXT NOT NULL,           -- user `sub`, 'system', or 'compliance:<sub>'
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','system','compliance')),
  action          TEXT NOT NULL,           -- enum below; closed set, validated on insert
  detail          TEXT NOT NULL,           -- JSON
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL,
  hmac_key_id     TEXT NOT NULL,           -- which key generated `hash` — supports rotation
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE INDEX idx_audit_submission ON audit_events(submission_id);
CREATE INDEX idx_audit_skill      ON audit_events(skill_name, version);
CREATE INDEX idx_audit_actor      ON audit_events(actor);
CREATE INDEX idx_audit_action     ON audit_events(action);
CREATE INDEX idx_audit_timestamp  ON audit_events(timestamp);
```

## Event Types (closed enum)

Defined as a TypeScript const so insert paths are statically checked. New types require a code change + spec update.

```typescript
// @asr/core/audit
export const AUDIT_ACTIONS = [
  // submission lifecycle
  'submission.created',
  'submission.classified',
  'submission.withdrawn',
  'submission.expired',

  // workflow transitions (matches every Flowcraft node terminal)
  'workflow.classify.completed',
  'workflow.pushed_to_forgejo',
  'workflow.questionnaire.completed',
  'workflow.scan.started',
  'workflow.scan.completed',
  'workflow.confirmation.received',
  'workflow.review.assigned',
  'workflow.review.approved',
  'workflow.review.rejected',
  'workflow.published',

  // scan detail (one row per finding for blame-able audit)
  'scan.finding',

  // versioning
  'version.published',
  'version.yanked',
  'version.diff.computed',

  // governance
  'hash.blocked',
  'token.rotated',
  'key.rotated',
  'audit.anchored',          // emitted every time a Git tag anchor is published
  'audit.verify.failed',     // emitted when chain verify detects a break
] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];
```

Workflow code MUST emit through a single helper:

```typescript
await audit.emit({
  action: 'workflow.review.approved',
  submissionId, skillName, version, actor, detail: { ... },
});
```

`audit.emit` validates the action against the enum at runtime (defensive against arbitrary strings sneaking in via dynamic dispatch) and computes the chain hash atomically within a single SQLite transaction with the state mutation it documents — the audit row and the workflow row land together or not at all.

## Hash Chain

```typescript
import { createHmac } from 'crypto';

function computeHash(
  event: Omit<AuditEvent, 'hash'>,
  hmacKey: Buffer,
): string {
  const payload = [
    event.id,
    event.submissionId ?? '',
    event.skillName ?? '',
    event.version ?? '',
    event.timestamp,
    event.actor,
    event.action,
    JSON.stringify(event.detail),
    event.prevHash,
  ].join('|');

  return createHmac('sha256', hmacKey).update(payload).digest('hex');
}
```

## Chain Verification

```typescript
async function verifyChain(db: Database, keys: KeyRing): Promise<VerifyResult> {
  const events = db.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
  let expectedPrev = '0'.repeat(64);
  for (const event of events) {
    if (event.prev_hash !== expectedPrev) {
      return { valid: false, brokenAt: event.id, reason: 'prev_hash mismatch' };
    }
    const key = keys.get(event.hmac_key_id);
    if (!key) return { valid: false, brokenAt: event.id, reason: 'unknown key' };
    if (computeHash(event, key) !== event.hash) {
      return { valid: false, brokenAt: event.id, reason: 'hash mismatch' };
    }
    expectedPrev = event.hash;
  }
  return { valid: true, eventCount: events.length, lastHash: expectedPrev };
}
```

If `verifyChain` ever returns `{ valid: false }`, the API enters **degraded mode**:
- All write endpoints return `503 audit_chain_broken`
- The dashboard displays a red banner
- An `audit.verify.failed` event is emitted (this is itself audited)
- On-call is paged via the standard alert rule (`audit.verify.failed > 0 in 5m`)

## HMAC Key Management

- Keys are 32-byte secrets stored in Azure Key Vault; the active key id is in env (`AUDIT_HMAC_KEY_ID`) and the key bytes are pulled from Key Vault on startup.
- A **KeyRing** holds the current key plus N previous keys (default N=3). Old events remain verifiable until their key is purged.
- **Rotation**: a `key.rotated` event is appended with both the old and new key ids. After rotation, all *new* events use the new key. Old events still verify against the old key via `hmac_key_id`.
- **Multi-replica consistency**: all API replicas read from the same Key Vault secret prefix and refresh on a `key.rotated` event broadcast (SSE from the leader replica). Until refresh, a replica that doesn't recognise an `hmac_key_id` fails closed (the audit verify endpoint returns `unknown key` rather than silently passing).

## External Anchoring

Every 100 events OR every hour (whichever comes first), a background job:

1. Reads the latest `hash` from `audit_events`.
2. Writes a signed Git tag `audit-anchor-{YYYYMMDDTHHMMSSZ}` in the `skills-registry` repo with the message containing `{lastHash, eventCount, hmacKeyId}`.
3. Tag is signed with the dedicated GPG key whose private half lives only in Key Vault (loaded by the anchor job, never logged).
4. Emits an `audit.anchored` event containing the tag name + commit sha.

Any attacker who tampers with the SQLite DB after an anchor must also forge the GPG signature (private key in Key Vault) or replace history in Forgejo (requires merge token + push to a protected ref, which is also blocked).

## Per-Skill / Per-User Views

These are first-class endpoints because compliance reviewers ask for them constantly:

```
GET /audit/skill/:owner/:name           — full history of a skill (all versions)
GET /audit/skill/:owner/:name/v:version — history of one version
GET /audit/user/:sub                    — every action performed by a principal
GET /audit/submission/:id               — single-submission timeline (used by reviewer UI)
GET /audit/verify                       — chain integrity check (admin only)
```

All require `Compliance` or `Admin` role except `/audit/submission/:id` which the submitter can also read for their own submissions.

## Retention & GDPR

- Audit events themselves are **never deleted** (SOC 2 / SOX requirement).
- Personally identifiable detail (email, display name) is **not** stored in `audit_events.detail`. The `actor` is a stable Entra ID `sub` (an opaque GUID).
- A separate `principals` table maps `sub → email/displayName` and is purgeable per GDPR Article 17. Audit queries then show `actor` as the sub only — no PII recovery without the principals table.
- Monthly partitioning via SQLite attached databases for archive management; archives are stored on Azure Files with immutable blob policy where supported.

## Read-Side Authorization

| Endpoint | Allowed |
|----------|---------|
| `GET /audit/submission/:id` | submitter (own only) or Compliance/Admin |
| `GET /audit/skill/...` | Compliance/Admin |
| `GET /audit/user/...` | Admin only (privacy-sensitive) |
| `GET /audit/verify` | Admin only (rate-limited; runs full table scan) |
