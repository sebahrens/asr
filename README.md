<p align="center">
  <h1 align="center">asr</h1>
  <p align="center">
    <strong>Self-Hosted Agent Skills Registry</strong>
    <br/>
    Submission, scanning, approval, and distribution platform for AI agent skills.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen.svg" alt="Node.js">
</p>

---

**asr** is a self-hosted registry for AI agent skills. Operators run their own [Forgejo](https://codeberg.org/forgejo/forgejo) instance as the Git backend, deploy the submission + registry service to Azure Container Apps (or any container host for dev), and let users submit skills through a vetted pipeline: classify → push to Forgejo → questionnaire → security scan → user confirmation → compliance review → publish.

## At a glance

| | |
|---|---|
| **Git backend** | Forgejo v15+ (self-hosted, never GitHub) |
| **Auth** | Microsoft Entra ID (OIDC), mock auth for local dev |
| **Workflow** | Flowcraft (HITL nodes, SQLite history) |
| **Scanning** | Dedicated container (Gitleaks + Trivy + Foxguard + Opengrep; Veracode optional) |
| **Distribution** | MCP server + marketplace Git repo + `asr` CLI |
| **Prod target** | Azure Container Apps (single canonical deployment) |
| **Dev target** | docker-compose with mock auth (no cloud dependency) |

## Documentation

| | |
|---|---|
| [SPEC.md](SPEC.md) | Index of all specs, phases, decision summary |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System topology, auth flows, networking |
| [DESIGN.md](DESIGN.md) | CLI distribution + publish approval design |
| [docs/mcp-clients.md](docs/mcp-clients.md) | MCP client configuration (Claude Code, Codex CLI, dev mode) |
| [specs/](specs/) | Detailed specifications for every subsystem |

The plan loop in [`ralph-scripts/`](ralph-scripts/) decomposes these specs into atomic backlog beads.

## Repository layout

```
packages/
├── cli/           # `asr` CLI (TypeScript, tsup-bundled to single ESM file)
├── core/          # Shared types, SKILL.md parser, Forgejo client
└── web/           # React 19 + Vite 6 SPA — registry browser + approval UI
# packages/submission/ (planned, Phase 1) — Hono submission service + MCP server
deploy/
└── docker/        # Dockerfiles + docker-compose for local dev (Forgejo + API + Web)
scripts/
└── e2e-docker.mjs # Docker-based smoke E2E driver
specs/             # See SPEC.md for the index
```

## Local development

```bash
pnpm install
node deploy/docker/prepare-env.mjs                         # local Forgejo secrets
docker compose --env-file deploy/docker/.env -f deploy/docker/docker-compose.yml up -d
pnpm dev                                                    # workspace dev
```

If Docker is unavailable and you only need the mock API for web UI development
or visual review, run:

```bash
pnpm dev:api
pnpm --filter @asr/web dev
```

Service URLs in dev:
- Forgejo  → http://localhost:3000
- API      → http://localhost:3001  (`AUTH_MODE=mock`)
- Web SPA  → http://localhost:5173

## Production deployment

Azure Container Apps via Bicep templates — see [specs/deployment.md](specs/deployment.md) for the full recipe (Container Apps Environment, Azure Files volumes, Key Vault secrets, ACR-mirrored Forgejo image, Forgejo Actions CI).

## Security posture

The MUST-HAVE controls and disclosed limitations are spelled out in [SPEC.md](SPEC.md#security-posture) and [specs/security.md](specs/security.md). Highlights:

- All submissions traverse the same Forgejo PR + merge path (auto-approve included) so Git history is the single source of truth.
- Zip extraction uses `yauzl` with explicit traversal/bomb/symlink/polyglot guards.
- Scan results are written by the system only; the upload token cannot merge to `main`.
- Audit chain is HMAC-linked and anchored periodically to a signed Git tag.
- Every published version has a canonical SHA-256 — rejected content is hash-blocked and cannot be re-published.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
