# Security Model

## Threat Model

The system accepts untrusted user-supplied archives containing arbitrary files. The primary threats are:
1. Malicious code published as legitimate skills
2. Bypass of the approval workflow
3. Tampering with audit records
4. Supply chain attacks on the system itself

## Zip Upload Hardening

### MUST-HAVE Controls

| Attack | Mitigation |
|--------|-----------|
| Path traversal (Zip Slip) | Resolve canonical path of each entry; reject if outside target dir |
| Zip bombs | Limits: 50MB compressed, 200MB uncompressed, 500 files max, 5 dir depth |
| Symlinks | Reject all symlinks and hard links; allow only regular files + directories |
| Device files | Reject all non-regular file types |
| Filename attacks | Reject non-printable chars, U+202E (RTL override), null bytes; max 200 char paths; NFC normalize |
| Polyglot files | Magic-byte sniff vs claimed extension; mismatch → reject |

### Library Choice

**`yauzl` (pinned `^3.0.0`).** `unzipper` is forbidden — it has a string of historical CVEs (path traversal, ReDoS) and its streaming behaviour makes bomb detection awkward. `yauzl` provides explicit per-entry control and is maintained.

### Implementation Sketch

```typescript
import yauzl from 'yauzl';
import { resolve, relative, sep } from 'path';
import { promisify } from 'util';

const LIMITS = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxFiles: 500,
  maxDepth: 5,
  maxPathLen: 200,
};

export async function extractSafe(zipPath: string, targetDir: string): Promise<string[]> {
  const canonical = resolve(targetDir);
  const zip = await promisify(yauzl.open)(zipPath, { lazyEntries: true, autoClose: true });

  let totalBytes = 0;
  let fileCount = 0;
  const files: string[] = [];

  return new Promise((doneResolve, doneReject) => {
    zip.readEntry();
    zip.on('entry', (entry) => {
      const name = entry.fileName.normalize('NFC');

      if (name.length > LIMITS.maxPathLen) return doneReject(new Error(`path too long: ${name}`));
      if (/[\x00-\x1f\u202e\u200f]/.test(name)) return doneReject(new Error(`illegal chars: ${name}`));

      const entryPath = resolve(targetDir, name);
      if (!entryPath.startsWith(canonical + sep)) return doneReject(new Error(`path traversal: ${name}`));

      if (relative(canonical, entryPath).split(sep).length > LIMITS.maxDepth)
        return doneReject(new Error(`max depth: ${name}`));

      const isDir = /\/$/.test(name);
      if (!isDir && (entry.externalFileAttributes >>> 16) & 0xa000)
        return doneReject(new Error(`symlink rejected: ${name}`));

      if (++fileCount > LIMITS.maxFiles) return doneReject(new Error('max files'));

      totalBytes += entry.uncompressedSize;
      if (totalBytes > LIMITS.maxUncompressedBytes) return doneReject(new Error('uncompressed size limit'));

      // ... extract entry to disk, then magic-byte sniff for polyglots ...
      files.push(relative(canonical, entryPath));
      zip.readEntry();
    });
    zip.on('end', () => doneResolve(files));
    zip.on('error', doneReject);
  });
}
```

## Classification: Whitelist Approach

**CRITICAL**: Whitelist, not blacklist. Only these file types are "content-only":

```typescript
const CONTENT_ONLY_EXTENSIONS = new Set([
  '.md', '.txt', '.rst',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.yaml', '.yml', '.json',
]);

function classifySkill(files: string[]): SkillClassification {
  const allContentOnly = files.every(f => {
    const ext = f.substring(f.lastIndexOf('.')).toLowerCase();
    return CONTENT_ONLY_EXTENSIONS.has(ext);
  });
  return allContentOnly ? 'md-only' : 'code-containing';
}
```

Files without extensions, or with unrecognized extensions, trigger the code path. SVGs are extra-validated to strip `<script>` and event handlers.

### Markdown XSS Prevention

- Strip all raw HTML from markdown (use `remark` with `remark-gfm`, **no** `rehype-raw`)
- Reject `javascript:` URIs in links
- Serve rendered content with `Content-Security-Policy: script-src 'none'`

## Canonical Content Hash

See [versioning.md#canonical-content-hash](versioning.md#canonical-content-hash). Single definition; this section just records the security implications:

- Same hash ⇒ same content ⇒ blocklist hit
- `blocked_hashes` is checked **before** any classification or scanning
- Implementation pinned in `@asr/core/hash` with snapshot tests so a future refactor cannot silently change the hash for the same input

## Security Scanning

External Docker container with Gitleaks + Trivy + Foxguard + Opengrep (Veracode optional). See [security-scanning.md](security-scanning.md). The in-process plugin scanner model has been removed entirely.

### Scanner Limitations (disclosed to compliance)

Static analysis CANNOT detect:
- Runtime-fetched payloads
- Conditional execution (env-gated)
- Steganographic payloads
- Build-time code generation

**Mitigation**: permissions manifest required for all code skills; runtime sandbox enforcement at the agent CLI honours `permissions.network`, `permissions.subprocess`, `permissions.filesystem` (Phase 4 + agent CLI updates).

## Authentication & Authorization

### Entra ID (OIDC)

All user-facing endpoints require a valid Entra ID bearer token. Token validation:
- Verify signature against JWKS endpoint (`https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`)
- Validate `aud` (audience) matches API client ID
- Validate `iss` (issuer) matches tenant
- Extract `roles` claim for authorization decisions
- `optionalClaims.idToken: [email, preferred_username]` configured on the app registration to work around the Codeberg #7427 v2 field-population issue

### Role-Based Access

| Role | Source | Permissions |
|------|--------|-------------|
| `Submitter` | Entra ID App Role | Upload, view own, questionnaire, confirm |
| `Compliance` | Entra ID App Role | View all, approve/reject, yank, audit access |
| `Admin` | Entra ID App Role | All + scanner config, system health, audit verify |

Separation of duties: `Compliance` cannot approve or yank their own submissions (checked via `sub` claim comparison at the API and at the HITL node).

### Mid-Flow Role Loss

A user who loses the `Compliance` role between picking up a review and submitting a decision has the decision rejected at submit time with `403 insufficient_permissions`. The submission returns to the queue and an audit event `review.assigned` is undone via a compensating `review.released` entry.

### Token Refresh

- **SPA**: MSAL `acquireTokenSilent`; on failure, full redirect to `/login` preserving `returnTo`.
- **CLI**: stored refresh token; on access-token expiry, silent refresh; on refresh failure, prompt device-code flow again.

### Dev Mode

When `AUTH_MODE=mock`:
- No token validation
- Mock identity injected with configurable `sub` (`MOCK_USER_SUB`) and roles (`MOCK_USER_ROLES`, CSV)
- Banner rendered in the SPA (yellow, persistent) reading `Mock auth: <roles>`
- The Dockerfile entrypoint hard-fails if `NODE_ENV=production` and `AUTH_MODE=mock` — production cannot accidentally boot in mock mode (see [submission-package.md](submission-package.md#production-mode-enforcement))

## Workflow Security

### Separation of Duties

```
Submitter ≠ Compliance Approver (enforced via Entra ID sub claim)
Compliance ≠ Submitter for yank (same rule)
Scan results written by system only (scanner container produces signed verdict)
Forgejo merge token separate from upload token
```

### Token Scoping (Forgejo)

| Token | Scope | Holder |
|-------|-------|--------|
| Upload token | `write:repository` scoped to `skills-registry` repo | Submission Service |
| Merge token | `write:repository` + merge whitelist membership | Submission Service (approval path only) |
| Package token | `write:package` | Submission Service (post-approval) |

The upload token CANNOT merge to main. Branch protection merge whitelist enforces this — only `asr-merge-bot` is whitelisted.

### Webhook Verification

Forgejo webhooks include an HMAC signature header. Forgejo's header name today is `X-Gitea-Signature` (legacy compatibility) plus `X-Forgejo-Signature`. The handler accepts either and verifies HMAC-SHA256 with `FORGEJO_WEBHOOK_SECRET`; missing/invalid signature → `401`.

### Race Condition Prevention

Per-skill optimistic locking via the `pending_versions` table; see [workflow.md#per-skill-mutex](workflow.md#per-skill-mutex).

## Versioning Security

See [versioning.md](versioning.md). Key invariants enforced here:

- Mandatory re-scan on every code change
- Rejected content blocklist by canonical hash
- Version downgrade prevention
- Yank flow records to both DB and Git history

## Audit Trail Integrity

See [audit.md](audit.md). Key invariants:

- HMAC hash chain across all events
- KeyRing supports rotation; events tagged with `hmac_key_id`
- Periodic Git tag anchoring with signed tags (GPG key in Key Vault)
- Chain break → API degrades to read-only + pages on-call

## Rate Limiting

Mutating endpoints are rate-limited per `sub`:

| Endpoint class | Limit |
|----------------|-------|
| `POST /submissions` | 10/hour/sub (configurable) |
| `POST /submissions/:id/*` | 60/min/sub |
| `POST /skills/:o/:n/v/:v/yank` | 10/hour/sub |
| MCP mutating tools | 60/min/sub |

Read endpoints follow [registry-api.md](registry-api.md#rate-limiting).

## CSRF

The SPA uses bearer tokens via `Authorization` header (not cookies), so CSRF is not applicable in the default configuration. If a future feature adds cookie-bearing flows (e.g. magic-link login), CSRF protection (SameSite=Strict + token) becomes required.
