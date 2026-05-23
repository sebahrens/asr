# Architecture

## System Overview

The Agent Skills Registry (ASR) is a submission and distribution platform for AI agent skills. It accepts skill uploads, runs security scanning and approval workflows, and publishes approved skills to a registry consumable by Claude Code, OpenAI Codex, and other MCP-compatible agents.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Azure Container Apps                             │
│                                                                          │
│  ┌─────────┐     ┌──────────────────────┐     ┌──────────────────────┐  │
│  │   Web   │     │    API / Submission   │     │      Forgejo         │  │
│  │  (SPA)  │────►│       Service         │────►│    (Git + Packages)  │  │
│  └─────────┘     └──────────────────────┘     └──────────────────────┘  │
│   external          external                      internal               │
│                         │                              │                 │
│                    ┌────┴─────┐                   ┌────┴─────┐          │
│                    │ Workflow │                   │  Repos   │          │
│                    │ (SQLite) │                   │  Packages│          │
│                    └──────────┘                   └──────────┘          │
│                    Azure Files                    Azure Files            │
└──────────────────────────────────────────────────────────────────────────┘
         │                    │
         │                    │
    ┌────┴────┐         ┌────┴────┐
    │ Entra ID│         │   CLI   │
    │  (OIDC) │         │  Tools  │
    └─────────┘         └─────────┘
```

## Services

### Web Frontend
- **Tech**: Vite + React SPA
- **Auth**: MSAL.js with Authorization Code + PKCE flow
- **Ingress**: External HTTPS
- **Scaling**: 0–3 replicas (static content, fast cold start)

### API / Submission Service
- **Tech**: Node.js (Hono or Express)
- **Auth**: Entra ID bearer token validation via JWKS
- **Responsibilities**: Upload handling, workflow orchestration, scan coordination, registry CRUD
- **State**: SQLite on Azure Files (`nobrl` mount)
- **Ingress**: External HTTPS
- **Scaling**: 1–3 replicas (min 1 for SQLite single-writer)

### Forgejo
- **Image**: `codeberg.org/forgejo/forgejo:15`
- **Role**: Git repository for skills source-of-truth, PR-based approval, generic package registry for skill artifacts
- **Auth**: OIDC via Entra ID (auto-registration enabled)
- **Ingress**: Internal only (API service communicates via REST)
- **Scaling**: Exactly 1 replica
- **Storage**: Azure Files for `/data` (repos, config, packages)

## Authentication & Authorization

### Identity Provider: Microsoft Entra ID

Single tenant, three app registrations:

| Registration | Purpose | Flow |
|-------------|---------|------|
| `asr-spa` | Web frontend | Authorization Code + PKCE |
| `asr-api` | API token validation | Bearer token (audience) |
| `asr-cli` | CLI tools | Device Authorization Grant (RFC 8628) |

### App Roles

Defined in the `asr-api` app registration and assigned via Entra ID:

| Role | Permissions |
|------|-------------|
| `Submitter` | Upload skills, view own submissions, answer questionnaire, confirm scan |
| `Compliance` | View all submissions, approve/reject, access audit trail |
| `Admin` | All above + manage scanners, configure registry, access system health |

### Token Flow

```
Web SPA ──PKCE──► Entra ID ──access_token──► API (validates via JWKS)
CLI     ──device code──► Entra ID ──access_token──► API
API     ──service token──► Forgejo API (PAT-based, machine account)
```

### Dev Mode (AUTH_MODE=mock)

In development, all auth is bypassed:
- API accepts any request, injects configurable mock identity
- Web uses a `MockAuthProvider` that skips MSAL
- Forgejo uses local admin token (no OIDC)
- Roles configurable via `MOCK_USER_ROLES` env var

## Git Backend: Forgejo

### Why Forgejo

- Self-hosted, no vendor lock-in
- REST API compatible with Octokit (change `baseUrl` to `/api/v1`)
- Built-in generic package registry for skill zip distribution
- OIDC/OAuth2 authentication (Entra ID supported)
- Fine-grained access tokens with repo-specific scoping (v15.0+)
- Branch protection with required reviews and status checks
- Webhooks with GitHub-compatible headers
- Docker image: 74 MiB, multi-arch

### Repository Structure

```
skills-registry/
├── skills/
│   └── {owner}/
│       └── {skill-name}/
│           ├── manifest.yaml
│           ├── SKILL.md
│           ├── scripts/          (optional)
│           └── CHANGELOG.md
├── reviews/
│   └── {owner}/
│       └── {skill-name}/
│           ├── v1.0.0-scan.json
│           └── v1.0.0-decision.json
├── .forgejo/
│   └── workflows/
│       ├── validate-submission.yml
│       └── periodic-rescan.yml
└── registry.json               (master index)
```

### Token Strategy

| Token | Scope | Used By |
|-------|-------|---------|
| Upload token | `write:repository` scoped to `skills-registry` repo | Submission Service (create branches, commits, PRs) |
| Merge token | `write:repository` + merge whitelist membership | Submission Service (approval path only) |

Branch protection on `main` prevents the upload token from merging — merge is restricted to the merge-whitelisted service account.

## Package Distribution

### Skill Artifacts via Forgejo Generic Registry

Published skills are stored as versioned packages:

```
PUT /api/packages/{org}/generic/{skill-name}/{version}/skill.zip
GET /api/packages/{org}/generic/{skill-name}/{version}/skill.zip
```

This provides:
- Versioned artifact storage with deduplication
- Download URLs for CLI tools
- No separate artifact server needed

### CLI Tool Integration

Skills are distributed to agent CLIs via three channels:

| Channel | Claude Code | Codex CLI | Mechanism |
|---------|-------------|-----------|-----------|
| MCP Server | `.mcp.json` entry | `config.toml` entry | `registry_search`, `registry_install` tools |
| Marketplace | `/plugin marketplace add` | `/plugins` browser | Git repo with `marketplace.json` |
| Direct install | `~/.claude/skills/` | `~/.codex/skills/` | File sync via `asr install` |

## Deployment

### Production: Azure Container Apps

```
Resource Group: asr-prod-rg
├── Container Apps Environment: asr-env
│   ├── Container App: web (external, 0-3 replicas)
│   ├── Container App: api (external, 1-3 replicas)
│   └── Container App: forgejo (internal, 1 replica)
├── Storage Account: asrstorage
│   ├── File Share: forgejo-data
│   └── File Share: api-data
├── Container Registry: asracr
├── Log Analytics Workspace: asr-logs
└── Key Vault: asr-secrets (Forgejo tokens, HMAC keys)
```

Key constraints:
- SQLite requires `nobrl` mount option on Azure Files (disables SMB byte-range locks)
- API must run exactly 1 write replica (single SQLite writer)
- Forgejo must run exactly 1 replica
- Web can scale to 0 (static SPA, fast cold start)

### Development: docker-compose

```yaml
services:
  forgejo:    # localhost:3000 — Git UI + API
  api:        # localhost:3001 — Submission + Registry API
  web:        # localhost:5173 — Vite dev server
```

All services start with `AUTH_MODE=mock` — no Entra ID dependency for local dev.

### Environment Variables

| Variable | Dev | Prod | Service |
|----------|-----|------|---------|
| `AUTH_MODE` | `mock` | `entra` | api |
| `AZURE_TENANT_ID` | — | `{tenant}` | api |
| `AZURE_CLIENT_ID` | — | `{client}` | api, web |
| `FORGEJO_URL` | `http://forgejo:3000` | `https://forgejo.internal...` | api |
| `FORGEJO_UPLOAD_TOKEN` | local PAT | Azure Key Vault | api |
| `FORGEJO_MERGE_TOKEN` | local PAT | Azure Key Vault | api |
| `DATABASE_PATH` | `./data/workflow.db` | `/app/data/workflow.db` | api |
| `VITE_AUTH_MODE` | `mock` | `entra` | web |
| `VITE_API_URL` | `http://localhost:3001` | `/api` | web |

## Networking

### Production (Azure Container Apps)

```
Internet
  │
  ├──► web.*.azurecontainerapps.io (external HTTPS)
  │       └── Static React SPA
  │
  ├──► api.*.azurecontainerapps.io (external HTTPS)
  │       └── Bearer token validation → Submission/Registry API
  │              │
  │              ▼ (internal HTTPS, auto-TLS via Envoy)
  │        forgejo.internal.*.azurecontainerapps.io
  │              └── Git repos + package registry
  │
  Azure Files (SMB, nobrl)
     ├── forgejo-data/ (repos, LFS, config)
     └── api-data/ (workflow.db, audit.db)
```

- Internal traffic between API and Forgejo uses automatic mTLS
- External endpoints get free managed TLS certificates
- CORS configured on API for web frontend origin

### Development (docker-compose)

All services on a shared Docker network. Ports exposed to host for debugging. No TLS.

## MCP Server Interface

The registry exposes an MCP server for direct agent integration:

```typescript
// Tools exposed:
registry_search(query, category?)    → skill list
registry_install(skillId, scope)     → installs to filesystem
registry_info(skillId)               → manifest + metadata
registry_list(filter?)               → all published skills
```

Configuration:
```json
// .mcp.json (Claude Code)
{
  "mcpServers": {
    "skill-registry": {
      "url": "https://api.asr.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ASR_TOKEN}" }
    }
  }
}
```

```toml
# ~/.codex/config.toml (Codex)
[mcp_servers.skill-registry]
url = "https://api.asr.example.com/mcp"
bearer_token_env_var = "ASR_TOKEN"
```

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Git backend | Forgejo | 15.0+ |
| API runtime | Node.js | 22 LTS |
| API framework | Hono | 4.x |
| Workflow | Flowcraft | latest |
| Database | SQLite (better-sqlite3) | 3.x |
| Frontend | React + Vite | 19 / 6.x |
| Auth library (web) | @azure/msal-react | 2.x |
| Auth library (api) | jwks-rsa + jsonwebtoken | — |
| Container platform | Azure Container Apps | — |
| Container registry | Azure Container Registry | Basic |
| Persistent storage | Azure Files (SMB) | — |
| Secrets | Azure Key Vault | — |
| Monitoring | Azure Log Analytics | — |
| CI/CD | Forgejo Actions | — |
