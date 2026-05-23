# Agent Skills Registry (ASR)

## Project Overview

Self-hosted Agent Skills Registry with submission pipeline, security scanning, and approval workflow. Distributes AI agent skills to Claude Code and OpenAI Codex via MCP server, marketplace repos, and CLI.

## Architecture

- **Git backend**: Forgejo v15+ (self-hosted, NEVER GitHub)
- **Deployment target**: Azure Container Apps (prod), docker-compose (dev). Cloudflare path has been removed — there is no longer a `packages/worker` or `deploy/cloudflare`.
- **Authentication**: Microsoft Entra ID (OIDC) in prod, mock auth in dev
- **Database**: SQLite (workflow state, audit trail; better-sqlite3, WAL)
- **Workflow engine**: Flowcraft (HITL nodes)
- **Security scanning**: Dedicated Docker container (Gitleaks + Trivy + Foxguard + Opengrep; Veracode optional). The old in-process plugin scanner model has been deleted — there is no `specs/scanners.md`.
- **Package distribution**: Forgejo generic package registry + MCP server + marketplace repo

## Key Documents

- `SPEC.md` — Index linking to all specs and the four implementation phases
- `ARCHITECTURE.md` — System topology, services, auth flows, networking
- `DESIGN.md` — CLI distribution and publish workflow design
- `specs/types.md` — **Canonical** TypeScript types (single source of truth)
- `specs/api.md` — Submission API (write side)
- `specs/registry-api.md` — Registry API (read side)
- `specs/mcp.md` — MCP server protocol, tools, auth
- `specs/workflow.md` — Flowcraft pipeline (auto-approve also goes through Forgejo PR)
- `specs/security.md` — Threat model, zip hardening (`yauzl`), auth lifecycle, rate limits
- `specs/security-scanning.md` — Container scanner pipeline
- `specs/git-integration.md` — Forgejo API usage (Octokit with baseUrl override; documented GitHub↔Forgejo deltas)
- `specs/audit.md` — HMAC chain, KeyRing rotation, Git-tag anchoring, retention vs GDPR
- `specs/versioning.md` — Strict semver, canonical content hash, yank flow, full change tracking
- `specs/web-ui.md` — React SPA routes, screens, states, acceptance tests
- `specs/submission-package.md` — Layout of the planned `packages/submission/`
- `specs/deployment.md` — Docker dev + Azure prod deployment
- `specs/cli-integration.md` — `asr` CLI commands, marketplace sync, auth

## Monorepo Structure

```
packages/
├── cli/          — `asr` CLI tool (TypeScript, tsup-bundled)
├── core/         — Canonical types, SKILL.md parser, Forgejo client
└── web/          — React SPA (Vite) — registry browser + approval UI
# packages/submission/ (planned, Phase 1) — Hono submission service hosting API + MCP server + workflow
deploy/
└── docker/       — Dockerfiles + docker-compose for local dev
specs/            — Detailed specification documents
ralph-scripts/    — Loop scripts that decompose specs into atomic beads (`bd`)
```

## Development

```bash
pnpm install
docker compose -f deploy/docker/docker-compose.yml up -d   # Forgejo + API + Web
pnpm dev                                                    # workspace dev
pnpm test                                                   # vitest in @asr/core
pnpm test:e2e                                               # Docker smoke E2E
```

- Dev mode: `AUTH_MODE=mock` — no Entra ID needed
- Forgejo at http://localhost:3000
- API at http://localhost:3001 (Hono on Node.js 22)
- Web at http://localhost:5173

## Conventions

- TypeScript strict mode throughout, Node.js 22 LTS, ESM
- pnpm workspace monorepo
- Forgejo REST API via Octokit with `baseUrl` override; per-file commits (no tree API)
- SQLite via better-sqlite3 (WAL mode)
- Hono for the API framework
- All secrets in env vars (Azure Key Vault in prod)
- Zip extraction uses `yauzl` only — never `unzipper`
- Canonical SHA-256 hash for every skill version (see `specs/versioning.md`)
- All audit events go through `audit.emit` with a closed action enum

## Hard Rules

- NEVER reference GitHub in new code — all git operations target Forgejo
- The Forgejo API is at `/api/v1` (not `/api/v3`)
- Branch protection uses Forgejo's merge-whitelist (not token scopes); the upload token cannot merge
- Forgejo's file creation API is per-file — commit sequentially with idempotency on `409`
- SQLite on Azure Files requires `nobrl` mount option
- Forgejo image: `codeberg.org/forgejo/forgejo:15`, mirrored to ACR for prod
- `NODE_ENV=production` + `AUTH_MODE=mock` MUST fail to boot (Dockerfile entrypoint enforces this)
- Canonical types live in `@asr/core` — never redefine `SkillManifest`, `SubmissionStatus`, `ScanReport`, etc. anywhere else
- Auto-approve still goes through a Forgejo PR + merge — there is no "direct write to main" path
