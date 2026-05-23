# Versioning & Change Tracking

Versioning is a **first-class concern**: every skill has a complete, auditable, queryable history of who changed what, when, why, and what scan/approval evidence backed each version. The Git history is the **source of truth**, mirrored into SQLite for cheap queries and into the audit chain for tamper-evidence.

## Invariant: every published change is a versioned commit in the repo

**Every** change to a skill — including pure-markdown edits, typo fixes, image swaps, tag tweaks — is a new semver version that goes through Forgejo: branch → PR → merge → Git tag → `skill_versions` row → `.publish-record.json` → audit chain → marketplace sync. There is no path that mutates a published skill in place. There is no path that writes to `main` without a PR. There is no "minor edit" shortcut that bypasses version tracking.

This applies symmetrically to:

| Change | Path | Approval | Versioned in repo? |
|--------|------|----------|--------------------|
| First publish of a skill | classify → push-to-forgejo → (md-only \| code) → publish | system or compliance | yes |
| Markdown content edit | classify → push-to-forgejo → md-only → auto-approve → publish | system | **yes** |
| New markdown file added | classify → push-to-forgejo → md-only → auto-approve → publish | system | **yes** |
| Image swap (whitelist asset only) | classify → push-to-forgejo → md-only → auto-approve → publish | system | **yes** |
| Tag / description edit | classify → push-to-forgejo → md-only → auto-approve → publish | system | **yes** |
| Any code change | classify → push-to-forgejo → questionnaire → scan → confirm → review → publish | compliance | yes |
| Yank | yank endpoint → commit `YANKED.md` + update `skill_versions` | compliance | yes (commit + tag retained, `yanked` flag set) |

The `classification` field (`md-only` vs `code-containing`) only determines whether human review nodes run — it never determines whether a Git commit, a tag, or a `skill_versions` row is created.

## Version Format

Strict [semver 2.0](https://semver.org) (`MAJOR.MINOR.PATCH`, optional pre-release `-beta.1`, optional `+build` ignored).

- Comparison library: `semver` (pinned `^7.6.0`) — single canonical version across all packages
- Pre-release ordering follows semver §11 (`1.0.0-beta.1 < 1.0.0`)

Stored in `manifest.yaml` within the skill:

```yaml
name: my-skill
version: 1.2.0
author: user@example.com
description: Does useful things
tags: [automation, api]
```

## Version Rules

| Rule | Enforcement |
|------|-------------|
| No duplicate `name@version` (published **or** pending) | Unique index on `(skill_name, version)` in `skill_versions` |
| No downgrades | `semver.gt(new, currentPublished)` check in submission API |
| Pre-release allowed but ordered properly | Comparison via `semver.compare` |
| Re-submission of same version forbidden (even after rejection) | Submitter must bump version |
| Rejected content forbidden by hash | Lookup against `blocked_hashes` (see below) |
| Yanked versions must not regress to "latest" | `latest` resolved over non-yanked, non-rejected only |

## Canonical Content Hash

A skill version's identity is its **canonical SHA-256**. The hash is computed over a deterministic zip:

```
For each entry, sorted by path (UTF-8 lexicographic):
  - path                       (UTF-8 bytes)
  - mode                       (0644 for files, 0755 if executable bit set in manifest)
  - mtime                      (fixed: 2000-01-01T00:00:00Z)
  - uncompressed size          (uint64 BE)
  - SHA-256 of file content    (32 bytes)

Hash = SHA-256( concat(above for every entry) )
```

This excludes Mac `.DS_Store`, `__MACOSX`, `.git/`, build artifacts, and any file the classifier strips. The implementation lives in `@asr/core/hash` (`canonicalHash(files): string`).

The same hash is used for:
- Deduplication (server returns 409 if hash already exists on any prior submission, including rejected)
- The `blocked_hashes` table (rejected content cannot be re-submitted under a new version)
- The `skill_versions.content_hash` column (one row per published version)

## Update Flow

```
User submits v1.1.0 (v1.0.0 currently published)
  │
  ├── Server resolves skill by name → finds v1.0.0 as current published
  ├── Validates semver.gt("1.1.0", "1.0.0")
  ├── Computes canonical hash → checks blocked_hashes (reject if match)
  ├── Generates VersionDiff (see below) and persists it
  ├── Classifies new files vs old files:
  │     ├── Only MD changed AND no new file types       → auto-approve path
  │     ├── Code changed OR new deps OR new file types  → full re-approval path
  │     └── Permissions manifest expanded               → full re-approval (always)
  │
  └── Triggers appropriate workflow path
```

## Re-approval Matrix

| Change (computed from VersionDiff) | Approval path |
|------------------------------------|---------------|
| Markdown content edits only | Auto-approve (still goes through Forgejo PR + merge for traceability) |
| New markdown files added | Auto-approve |
| Any code file added or modified | Full re-scan + compliance approval |
| New dependency added | Full re-scan + compliance approval |
| Dependency patch bump only | Re-scan; auto-approve **only if** scan is clean |
| Dependency major/minor bump | Full re-scan + compliance approval |
| New file type introduced | Full re-scan + compliance approval |
| Permissions manifest expanded | Full re-scan + compliance approval |
| Permissions manifest narrowed | Re-scan; auto-approve if clean |
| `manifest.yaml` `kind` or `persona_mode` changed | Full re-scan + compliance approval |

## VersionDiff (canonical type)

```typescript
// @asr/core/types
export interface VersionDiff {
  skillName: string;
  fromVersion: string;            // empty for first publish
  toVersion: string;
  fromContentHash: string | null; // null on first publish
  toContentHash: string;
  filesAdded: string[];           // paths
  filesRemoved: string[];
  filesModified: string[];        // paths where blob hash changed
  dependenciesAdded: Record<string, string>;     // name → version range
  dependenciesRemoved: Record<string, string>;
  dependenciesChanged: Record<string, { from: string; to: string }>;
  permissionsBefore: PermissionsManifest | null;
  permissionsAfter: PermissionsManifest;
  permissionsExpanded: boolean;   // true if any net-new capability granted
  manifestKindChanged: boolean;
  riskAssessment: 'low' | 'medium' | 'high';
  computedAt: string;             // ISO 8601
}
```

Risk auto-assessment is a pure function of the diff:
- **low**: only MD changes, narrowed or unchanged permissions
- **medium**: code edits within existing files, no new deps, no expanded permissions
- **high**: new deps, expanded permissions, new file types, kind/persona_mode change

`VersionDiff` is computed before classification (so the workflow can branch on `permissionsExpanded`) and stored in `version_diffs` for reviewer consumption and audit.

## Storage

```sql
-- Authoritative version index (queryable mirror of Git history)
CREATE TABLE skill_versions (
  skill_name      TEXT NOT NULL,
  version         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  submission_id   TEXT NOT NULL REFERENCES submissions(id),
  published_at    TEXT NOT NULL,
  published_by    TEXT NOT NULL,             -- submitter sub
  approved_by     TEXT,                       -- compliance sub (null for auto-approved)
  pr_number       INTEGER NOT NULL,
  merge_commit    TEXT NOT NULL,              -- sha of the Forgejo merge commit
  scan_report_id  TEXT REFERENCES scan_results(id),
  yanked_at       TEXT,
  yanked_by       TEXT,
  yank_reason     TEXT,
  PRIMARY KEY (skill_name, version)
);

CREATE INDEX idx_versions_hash  ON skill_versions(content_hash);
CREATE INDEX idx_versions_pub   ON skill_versions(published_at);
CREATE INDEX idx_versions_yanked ON skill_versions(skill_name) WHERE yanked_at IS NULL;

-- Per-submission diff against the prior published version (if any)
CREATE TABLE version_diffs (
  submission_id   TEXT PRIMARY KEY REFERENCES submissions(id),
  from_version    TEXT,
  to_version      TEXT NOT NULL,
  diff_json       TEXT NOT NULL,              -- serialised VersionDiff
  risk            TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  computed_at     TEXT NOT NULL
);

-- Hashes that must never be re-published
CREATE TABLE blocked_hashes (
  content_hash    TEXT PRIMARY KEY,
  skill_name      TEXT NOT NULL,
  version         TEXT NOT NULL,
  blocked_at      TEXT NOT NULL,
  blocked_by      TEXT NOT NULL,              -- compliance sub or 'system'
  reason          TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('rejected','yanked','incident'))
);
```

`skill_versions` is the queryable view. The Git history (`git log -- skills/<owner>/<name>/`) remains the durable source of truth — `skill_versions` can be rebuilt from Git if lost.

## Yank Flow (security incident response)

A published version can be **yanked** after the fact. Yanking does **not** delete the artifact (auditors must still be able to see what was published), but:

1. Marks the version as yanked in `skill_versions` (`yanked_at`, `yanked_by`, `yank_reason`).
2. Adds the content hash to `blocked_hashes` with `source='yanked'`.
3. Removes the artifact from `latest` resolution. CLI `asr install <skill>` (no version) skips yanked versions; explicit `asr install <skill>@<yanked-version>` errors with a clear yank message + reason.
4. Emits `version.yanked` audit event (see audit.md).
5. Notifies all users who have the version installed via the upcoming **install telemetry** opt-in (deferred to a later phase; until then the CLI checks `latest` on every `asr update`).
6. Webhook fires `skill.yanked` for downstream consumers (marketplace mirrors).
7. The Forgejo PR-based audit chain records a yank commit in `skills/<owner>/<name>/YANKED.md` so Git history reflects the action.

### Endpoint

```
POST /skills/:owner/:name/versions/:version/yank
  Body: { reason: string, severity: 'low'|'high'|'critical' }
  Auth: Compliance role + must differ from `published_by`
  201 → { yanked: true, blocked_hash: "..." }
```

### Re-publish after yank

A yanked version cannot be re-published under the same number. The submitter must bump version **and** ship different content (different canonical hash). The system refuses any re-submission whose canonical hash matches any `blocked_hashes` row, regardless of severity.

## Diff Presentation

For the compliance reviewer UI ([specs/web-ui.md](web-ui.md#approval-detail-screen)):

- Summary header: from/to versions, risk badge, files +/- counts
- Tabbed view: Files (split diff per file, syntax-highlighted), Dependencies (table of added/removed/changed), Permissions (before/after json), Scan findings (linked to scan_results)
- "Why re-approval?" banner naming each rule from the matrix above that was triggered

## Latest-Version Resolution

```sql
-- The single canonical "latest" query, reused by CLI, MCP, web UI:
SELECT version FROM skill_versions
 WHERE skill_name = ?
   AND yanked_at IS NULL
 ORDER BY  -- semver order
   CAST(SUBSTR(version, 1, INSTR(version,'.')-1) AS INTEGER) DESC,
   ...
 LIMIT 1;
```

Implementations must defer ordering to `semver.rsort` rather than SQL (the SQL sketch is for cache invalidation only). The CLI and MCP must call `GET /skills/:owner/:name` which returns the resolved `latest` plus `versions[]`.

## Concurrent Submissions

Two submissions for the same `name@version` cannot coexist:

- `(skill_name, version)` unique constraint on `skill_versions`
- During the workflow, a row in `pending_versions(skill_name, version, submission_id)` provides a soft lock; the submission API rejects with `409 version_in_progress` if a row exists

Two submissions for the **same skill at different versions** can coexist, but the workflow uses a per-skill mutex (see [specs/workflow.md](workflow.md#per-skill-mutex)) so they merge to `main` in the order they complete approval, not the order they were submitted.

## CLI Contract

```
asr versions <owner/skill>           # lists all versions (yanked marked, latest highlighted)
asr install <owner/skill>            # latest non-yanked
asr install <owner/skill>@<version>  # explicit; refuses yanked versions
asr update <owner/skill>             # bumps to latest non-yanked, prints diff summary
asr yank <owner/skill>@<version>     # compliance-only; requires --reason
```

Every CLI mutation that changes installed versions writes to the local `.agent/asr.lock.json` and the per-install audit log so the user can answer "what changed?".

## Git History as Source of Truth

```bash
# Full version history for a skill
git log --pretty=format:'%H %ai %an %s' -- skills/<owner>/<name>/

# Compare two versions
git diff v<owner>--<name>--1.0.0 v<owner>--<name>--1.1.0 -- skills/<owner>/<name>/

# Get the canonical hash recorded at publish time
git show v<owner>--<name>--1.0.0:skills/<owner>/<name>/.publish-record.json
```

Each merge commit for a published version writes `.publish-record.json` containing the canonical hash, scan report id, approver, and Flowcraft run id — so even with the SQLite database wiped, every version remains independently verifiable from Git.
