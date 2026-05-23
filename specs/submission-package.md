# `packages/submission/` — Layout

This is the Node.js + Hono service that hosts the submission API, the registry read API, the MCP server, the Flowcraft workflow runner, and the audit chain. It is the single deployable unit behind the API Container App.

## Module Layout

```
packages/submission/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              — Hono app composition + server bootstrap
│   ├── env.ts                — env var parsing (zod-validated)
│   ├── auth/
│   │   ├── entra.ts          — JWKS validation middleware
│   │   ├── mock.ts           — AUTH_MODE=mock provider
│   │   └── separation.ts     — submitter≠approver guard
│   ├── http/
│   │   ├── submissions.ts    — POST/GET /submissions, lifecycle endpoints
│   │   ├── registry.ts       — GET /skills, GET /skills/:owner/:name
│   │   ├── audit.ts          — GET /audit/*
│   │   ├── health.ts         — GET /health, GET /version
│   │   ├── webhooks.ts       — Forgejo webhook receiver (PR events)
│   │   └── errors.ts         — error envelope + status mapping
│   ├── mcp/
│   │   ├── server.ts         — McpServer composition
│   │   └── tools/            — one file per tool from specs/mcp.md
│   ├── workflow/
│   │   ├── pipeline.ts       — Flowcraft Blueprint
│   │   ├── nodes/
│   │   │   ├── classify.ts
│   │   │   ├── pushToForgejo.ts
│   │   │   ├── questionnaire.ts
│   │   │   ├── scan.ts        — invokes scanner container
│   │   │   ├── confirmation.ts
│   │   │   ├── review.ts
│   │   │   └── publish.ts
│   │   ├── mutex.ts          — per-skill optimistic locking helper
│   │   └── resume.ts         — crash-recovery driver run at startup
│   ├── forgejo/              — re-exports @asr/core/forgejo + service-bound helpers
│   ├── scan/
│   │   ├── runner.ts         — docker exec of asr-scanner image (or bind-mount in dev)
│   │   └── report.ts         — ScanReport persistence + verdict computation
│   ├── audit/
│   │   ├── emit.ts           — single insert helper, validates AUDIT_ACTIONS
│   │   ├── verify.ts         — chain verification
│   │   ├── anchor.ts         — periodic Git-tag anchoring job
│   │   └── keyring.ts        — HMAC KeyRing with Key Vault loader
│   ├── db/
│   │   ├── index.ts          — better-sqlite3 connection (WAL)
│   │   ├── migrations/       — sequential .sql files; runner pinned to up-only
│   │   └── repositories/     — one repo per aggregate (submissions, skill_versions, ...)
│   ├── zip/
│   │   ├── extract.ts        — yauzl-based safe extractor
│   │   ├── classify.ts       — whitelist classifier
│   │   └── canonicalHash.ts  — canonical SHA-256 per specs/versioning.md
│   └── jobs/
│       ├── anchor.ts         — cron: audit anchoring every 100 events / 1h
│       ├── rescan.ts         — cron: periodic re-scan of published skills
│       └── marketplaceSync.ts — cron: regenerate registry.json + marketplace repo
└── test/
    ├── unit/
    ├── integration/          — runs against a temp SQLite + a forgejo testcontainer
    └── fixtures/
```

## package.json

```json
{
  "name": "@asr/submission",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "test:integration": "vitest run --dir test/integration"
  },
  "dependencies": {
    "@asr/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@octokit/rest": "^21.0.0",
    "better-sqlite3": "^11.0.0",
    "flowcraft": "*",
    "hono": "^4.6.0",
    "jsonwebtoken": "^9.0.0",
    "jwks-rsa": "^3.0.0",
    "pino": "^9.0.0",
    "semver": "^7.6.0",
    "ulid": "^2.3.0",
    "yauzl": "^3.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/node": "^22.0.0",
    "@types/yauzl": "^2.10.0",
    "tsup": "^8.3.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.0"
  }
}
```

## Composition

```typescript
// src/index.ts
import { Hono } from 'hono';
import { Server } from 'node:http';
import { env } from './env.js';
import { authMiddleware } from './auth/entra.js';
import { submissionRoutes } from './http/submissions.js';
import { registryRoutes } from './http/registry.js';
import { auditRoutes } from './http/audit.js';
import { mcpHandler } from './mcp/server.js';
import { healthRoutes } from './http/health.js';
import { webhookRoutes } from './http/webhooks.js';
import { runMigrations } from './db/migrations/index.js';
import { startJobs } from './jobs/index.js';
import { resumeWorkflows } from './workflow/resume.js';

await runMigrations();
await resumeWorkflows();
startJobs();

const app = new Hono();

app.route('/health',          healthRoutes);            // unauth
app.route('/api/v1/skills',   registryRoutes);          // unauth
app.use('/api/v1/*', authMiddleware);
app.route('/api/v1/submissions', submissionRoutes);
app.route('/api/v1/audit',       auditRoutes);
app.route('/webhooks',           webhookRoutes);         // HMAC-verified
app.all('/mcp', mcpHandler);                            // own auth gate inside

new Server(app.fetch).listen(env.PORT);
```

## Concurrency Model

- **Single write replica** for SQLite (enforced by Container Apps `min=max=1` on a separate `api-write` app, or by acquiring a leader lock if scaled). Reads can scale on a separate replica set in a later phase.
- **Per-skill workflow mutex** via `pending_versions(skill_name, version, submission_id)` unique row; insert fails → `409 version_in_progress`.
- **Crash recovery**: on startup, `resumeWorkflows` finds all submissions in non-terminal states and re-enters the Flowcraft engine; compute nodes are idempotent (every external call carries an idempotency key derived from `(submissionId, nodeName, attempt)`).

## Environment

| Var | Required | Notes |
|-----|----------|-------|
| `PORT` | yes | default 3001 |
| `NODE_ENV` | yes | `development` \| `production` |
| `AUTH_MODE` | yes | `mock` \| `entra` |
| `MOCK_USER_SUB` | iff `mock` | stable subject id |
| `MOCK_USER_ROLES` | iff `mock` | comma-separated, e.g. `Submitter,Compliance` |
| `AZURE_TENANT_ID` | iff `entra` | |
| `AZURE_CLIENT_ID` | iff `entra` | API app registration |
| `FORGEJO_URL` | yes | base URL, e.g. `http://forgejo:3000` |
| `FORGEJO_UPLOAD_TOKEN` | yes | scoped: write:repository on skills-registry |
| `FORGEJO_MERGE_TOKEN` | yes | merge whitelist member |
| `FORGEJO_OWNER` | yes | repo owner |
| `FORGEJO_REPO` | yes | repo name (e.g. `skills-registry`) |
| `FORGEJO_WEBHOOK_SECRET` | yes | HMAC for webhook verification |
| `DATABASE_PATH` | yes | path to `workflow.db` |
| `AUDIT_HMAC_KEY_ID` | yes | active HMAC key id (looked up via Key Vault in prod) |
| `AUDIT_HMAC_KEY_BYTES` | dev only | base64 32-byte key (prod pulls from Key Vault) |
| `AUDIT_GPG_KEY_ID` | yes | key id for signing audit anchors |
| `SCANNER_IMAGE` | yes | e.g. `asr-scanner:latest` |
| `SCANNER_TIMEOUT_SECONDS` | no | default 300 |
| `SCANNER_SEVERITY_THRESHOLD` | no | default `high` |
| `VERACODE_API_KEY_ID` / `VERACODE_API_KEY_SECRET` | no | optional Tier 3 |

`src/env.ts` validates these with zod and refuses to boot if anything required is missing — fail-fast, never silently default in prod.

## Production-Mode Enforcement

`src/auth/entra.ts` refuses to load if `NODE_ENV=production` and `AUTH_MODE=mock`. The check is repeated by the Dockerfile entrypoint:

```sh
if [ "$NODE_ENV" = "production" ] && [ "$AUTH_MODE" = "mock" ]; then
  echo "FATAL: AUTH_MODE=mock is forbidden in production" >&2
  exit 78
fi
```

## Testing

- `vitest run` — unit tests against in-memory dependencies (sqlite `:memory:`, Forgejo client mock)
- `vitest run --dir test/integration` — spins up a Forgejo testcontainer + the API; runs scenarios end-to-end including a real scan container invocation (`asr-scanner` built locally)
- Snapshot tests for the canonical hash to guarantee future refactors don't change it
