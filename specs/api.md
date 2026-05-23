# Submission API (write side)

Mutating endpoints owned by the submission service. Read-only registry endpoints live in [registry-api.md](registry-api.md); MCP tools live in [mcp.md](mcp.md). Both share the auth model defined here.

Base URL: `/api/v1`

## Endpoints

### Upload & Lifecycle

```
POST   /submissions                   Upload skill.zip, start workflow
GET    /submissions                   List submissions (filter: ?status=pending, scope: own vs all by role)
GET    /submissions/:id               Get submission detail + current workflow state
DELETE /submissions/:id               Cancel/withdraw a submission (submitter only, only while non-terminal)
```

### Workflow Interactions

```
POST   /submissions/:id/questionnaire   Submit questionnaire answers (submitter)
GET    /submissions/:id/scan            Get scan report (ScanReport from specs/types.md)
POST   /submissions/:id/confirm         User acknowledges scan findings (submitter)
POST   /submissions/:id/approve         Compliance approves (separation-of-duties enforced)
POST   /submissions/:id/reject          Compliance rejects (body: {reason: string})
```

### Audit & History

```
GET    /submissions/:id/audit           Audit trail for a submission
GET    /submissions/:id/diff            VersionDiff against current published version (or null for first publish)
```

Cross-cutting audit endpoints (`/audit/skill/:o/:n`, `/audit/user/:sub`, `/audit/verify`) live under their own router; see [audit.md](audit.md#per-skill--per-user-views).

### Webhook Receiver

```
POST   /webhooks/forgejo                Forgejo PR events; HMAC-verified, no Entra token
```

Signature verification per [git-integration.md](git-integration.md#webhooks).

### Versioning

```
POST   /skills/:owner/:name/versions/:version/yank   Yank a published version (Compliance only)
```

Body and behaviour per [versioning.md#yank-flow-security-incident-response](versioning.md#yank-flow-security-incident-response).

### Health & Meta

```
GET    /health                          Liveness probe
GET    /version                         Build sha + spec version
```

## Request/Response Schemas

### POST /submissions

```typescript
// Request: multipart/form-data
// - file: skill.zip (binary)
// - manifest: JSON string (optional override of in-zip manifest.yaml, advisory)

// Response 201:
{
  id: string;                                   // ULID
  status: { phase: 'uploaded' };
  manifest: SkillManifest;                      // canonical, parsed from zip
  contentHash: string;                          // canonical SHA-256
  createdAt: string;
}

// 409 Conflict:
{ error: 'version_already_exists' | 'version_in_progress' | 'content_blocked' }
```

### POST /submissions/:id/questionnaire

```typescript
// Request:
{
  responses: Array<{
    questionId: string;
    answer: string | boolean;
  }>;
}

// Response 200:
{ status: { phase: 'scanning'; scanJobId: string } }
```

### GET /submissions/:id/scan

Returns the `ScanReport` from [types.md](types.md#scanning) verbatim.

### POST /submissions/:id/approve

```typescript
// Request:
{ comment?: string }

// Response 200:
{
  status: { phase: 'published'; publishedAt: string; mergeCommit: string };
  publishedVersion: string;
  registryUrl: string;
}

// 403 Forbidden:
{ error: 'insufficient_permissions'; required: 'Compliance' }
{ error: 'separation_of_duties_violation' }   // submitter == approver
```

### POST /submissions/:id/reject

```typescript
// Request:
{ reason: string }                             // required, 10–500 chars

// Response 200:
{ status: { phase: 'rejected'; rejectedAt: string; reason: string } }
```

### GET /submissions/:id/audit

```typescript
// Response 200:
{
  events: AuditEvent[];                        // type per specs/types.md#audit
  chainValid: boolean;                         // per-submission verify; full chain via /audit/verify
}
```

## Authentication & Authorization

### Entra ID Integration

All endpoints (except `/health`, `/version`, and `/webhooks/*`) require a valid bearer token from Microsoft Entra ID.

Validation per [security.md#entra-id-oidc](security.md#entra-id-oidc).

**Dev mode** (`AUTH_MODE=mock`): no token required; mock identity injected with configurable `sub` (`MOCK_USER_SUB`) and roles (`MOCK_USER_ROLES` CSV). Banner displayed in the SPA. Boot refuses if `NODE_ENV=production` and `AUTH_MODE=mock`.

### Role Matrix

| Endpoint | Required Role | Additional Constraint |
|----------|--------------|----------------------|
| `POST /submissions` | `Submitter` | — |
| `POST /:id/questionnaire` | `Submitter` | same user who uploaded (`sub` match) |
| `POST /:id/confirm` | `Submitter` | same user who uploaded (`sub` match) |
| `DELETE /:id` | `Submitter` | own + non-terminal status |
| `POST /:id/approve` | `Compliance` | submitter ≠ approver |
| `POST /:id/reject` | `Compliance` | submitter ≠ approver |
| `POST /skills/.../yank` | `Compliance` | yanker ≠ publisher |
| `GET /submissions` | `Submitter` (own) or `Compliance` (all) | — |
| `GET /:id`, `GET /:id/*` | `Submitter` (own) or `Compliance` (all) | — |
| `POST /webhooks/*` | none (HMAC) | constant-time signature compare |
| `GET /health`, `GET /version` | none | — |

### Entra ID App Registration

**App Roles** (defined in `asr-api` manifest):
```json
[
  { "value": "Submitter",  "displayName": "Skill Submitter",     "allowedMemberTypes": ["User"] },
  { "value": "Compliance", "displayName": "Compliance Reviewer", "allowedMemberTypes": ["User"] },
  { "value": "Admin",      "displayName": "Registry Admin",      "allowedMemberTypes": ["User"] }
]
```

**API Permissions** exposed by `asr-api`:
- `access_as_user` — delegated permission for SPA and CLI

**CLI Authentication** (`asr-cli` app, public client):
- `is-fallback-public-client: true`
- Scopes: `api://asr-api/access_as_user offline_access`

## Error Responses

Unified envelope. Always JSON; the `error` value is from a closed enum so clients can branch reliably.

```typescript
type ApiError =
  | 'authentication_required'
  | 'insufficient_permissions'
  | 'separation_of_duties_violation'
  | 'submission_not_found'
  | 'submission_in_progress'
  | 'version_already_exists'
  | 'version_in_progress'
  | 'version_yanked'
  | 'version_downgrade'
  | 'invalid_zip'
  | 'invalid_manifest'
  | 'content_blocked'
  | 'too_many_requests'
  | 'audit_chain_broken'
  | 'internal_error';

// 4xx body:
{ error: ApiError; message?: string; details?: Record<string, string>; required?: string; retryAfterSeconds?: number }
```

Status codes follow standard semantics: 400 (validation), 401 (auth), 403 (authz), 404 (resource), 409 (conflict), 422 (semantic), 429 (rate-limited), 503 (`audit_chain_broken`).
