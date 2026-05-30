# Agent Skills Registry — Specification Index

## Overview

A submission pipeline for the Agent Skills Registry that accepts skill uploads, classifies contents, and routes through an approval workflow before publishing. The system uses **Forgejo** as the self-hosted Git backend, **Entra ID** for authentication, and deploys to **Azure Container Apps**. Security scanning runs in a **dedicated container** (Gitleaks + Trivy + Foxguard + Opengrep, optional Veracode) — there is no in-process plugin scanner model. An **optional, provider-pluggable LLM content screen** (OpenAI / Anthropic and compatible endpoints) additionally checks that a submitter's declared permissions and questionnaire answers match the actual code — advisory for code-containing skills, a fail-closed gate for otherwise-unreviewed md-only skills.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│   Upload ──► Classify ──► Route                                       │
│                             │                                         │
│               ┌─────────────┼──────────────┐                          │
│               │                            │                          │
│          MD-only                     Code-containing                  │
│               │                            │                          │
│      Push to Forgejo (auto-PR)     Push to Forgejo                    │
│               │                            │                          │
│      Auto-approve & merge          Questionnaire                      │
│               │                            │                          │
│               │                    Container Scan                     │
│               │                            │                          │
│               │                    User Confirms Findings             │
│               │                            │                          │
│               │                    Compliance Approval                │
│               │                            │                          │
│               └────────────────┬───► Merge PR + Publish               │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

Even the auto-approve path now creates a branch + PR + merge so that the registry's Git history remains the single source of truth for every published artifact (no out-of-band writes to `main`).

**Invariant** (see [specs/versioning.md](specs/versioning.md#invariant-every-published-change-is-a-versioned-commit-in-the-repo)): every change to a skill — including pure-markdown edits, typo fixes, image swaps, tag tweaks — is a new semver version that lands as a Git commit, a Git tag, a `skill_versions` row, a `.publish-record.json`, an audit chain entry, and a marketplace-sync run. There is no in-place mutation path.

## Detailed Specifications

| Area | Document |
|------|----------|
| TypeScript types (canonical) | [specs/types.md](specs/types.md) |
| Workflow engine & pipeline | [specs/workflow.md](specs/workflow.md) |
| Security model & threats | [specs/security.md](specs/security.md) |
| Submission API (write side) | [specs/api.md](specs/api.md) |
| Registry API (read side) | [specs/registry-api.md](specs/registry-api.md) |
| MCP server | [specs/mcp.md](specs/mcp.md) |
| Web UI (routes, screens) | [specs/web-ui.md](specs/web-ui.md) |
| Submission package layout | [specs/submission-package.md](specs/submission-package.md) |
| Git integration (Forgejo) | [specs/git-integration.md](specs/git-integration.md) |
| Audit trail | [specs/audit.md](specs/audit.md) |
| Security scanning pipeline (container) | [specs/security-scanning.md](specs/security-scanning.md) |
| Versioning & updates | [specs/versioning.md](specs/versioning.md) |
| Deployment (Docker dev + Azure prod) | [specs/deployment.md](specs/deployment.md) |
| CLI integration (Claude/Codex) | [specs/cli-integration.md](specs/cli-integration.md) |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design including deployment topology, authentication flows, and container layout.

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Git backend | [Forgejo](https://codeberg.org/forgejo/forgejo) v15+ | Self-hosted, GitHub-compatible API, built-in package registry, OIDC support |
| Workflow engine | [Flowcraft](https://github.com/gorango/flowcraft) | Zero-dep, native HITL nodes, SQLite history, MIT |
| Git strategy | Single mono-repo, PR-based, **all paths through PR** (auto-approve included) | Atomic submissions, single source of truth in Git history |
| Audit storage | SQLite + HMAC hash chain + Git tag anchoring | Queryable, tamper-evident, externally verifiable |
| Classification | Whitelist approach | Only known-safe extensions bypass approval; everything else triggers code path |
| Scanning | **External Docker container** with Gitleaks/Trivy/Foxguard/Opengrep (optional Veracode) | Reproducible, isolated, language-agnostic; no in-process plugin loading |
| LLM screening | **Optional, provider-pluggable** (OpenAI/Anthropic + compatible) semantic screen of declared-vs-actual; advisory for code, fail-closed gate for md-only | Catches lies static rules can't; activated by env, never blocks legit code submissions |
| Web branding | **Build-time** `VITE_BRAND` (`pwc` default / `neutral`); no runtime toggle | One image per brand; secret-free; product name "Agent Skill Repository" in both |
| Versioning | Strict semver, mandatory re-scan on code changes, explicit yank flow | No approval inheritance between versions |
| Authentication | Microsoft Entra ID (OIDC) | Enterprise SSO, role-based access, device code flow for CLIs |
| Deployment (prod) | **Azure Container Apps only** (Cloudflare Workers path removed) | Serverless, scale-to-zero web, managed TLS, single deployment story |
| Deployment (dev) | docker-compose with mock auth | No cloud dependency for local development |
| Container registry | Azure Container Registry (service images) + Forgejo generic packages (skill artifacts) | Separation of platform vs content artifacts |
| CLI distribution | Forgejo Releases (single bundled ESM file) | No npm dependency for end users; reproducible installs |
| MCP distribution | MCP server endpoint + marketplace Git repo | Native integration with Claude Code and Codex CLI |
| Zip extraction lib | `yauzl` (pinned) | Maintained, minimal CVE history, streaming API |
| Content hash | SHA-256 over a canonical zip (sorted entries, fixed mtime, no extras) | Deterministic blocklist + dedupe |

## Security Posture

### MUST-HAVE (blocks launch)

1. Zip extraction hardening (path traversal, bombs, symlinks, polyglots)
2. Whitelist classification (not blacklist)
3. Separation of duties (submitter ≠ approver) enforced via Entra ID `sub` comparison
4. Scan results written by system only (scanner container produces signed verdict)
5. Dual Forgejo tokens (upload cannot merge; merge whitelist enforces this)
6. Full re-scan on every version change (no inheritance)
7. Audit chain anchored to signed Git tag at least hourly
8. Rejected-content blocklist keyed by canonical SHA-256
9. Entra ID token validation on all mutating REST and MCP endpoints
10. Per-skill workflow mutex (optimistic locking on `submissions.status`)

### SHOULD-HAVE (hardening)

1. Runtime permissions manifest enforcement (CLI side at install)
2. Polyglot file detection in zip extractor
3. Periodic bulk re-scan of published skills
4. CSRF protection for cookie-bearing browser flows (SPA uses bearer tokens, so N/A unless cookies are added)
5. Rate limiting per principal on upload + scan-trigger endpoints

### Disclosed Limitations

Static analysis cannot catch:
- Runtime-fetched payloads
- Conditional execution (env-gated)
- Build-time code generation
- Steganographic payloads

These limitations are surfaced to compliance reviewers in the questionnaire.

## Implementation Phases

Dependencies between phases are explicit. The plan loop must encode these as `bd dep add` between the corresponding epics.

### Phase 1 — Foundation (Week 1–2)

**Goal**: A submitted MD-only skill makes it through Forgejo to a published state, end-to-end, in dev.

- Scaffold `packages/submission/` per [specs/submission-package.md](specs/submission-package.md)
- Canonical types in `@asr/core` per [specs/types.md](specs/types.md)
- Forgejo client (branch, per-file commit, PR, merge, generic package upload) per [specs/git-integration.md](specs/git-integration.md)
- Zip classifier + safe extractor per [specs/security.md](specs/security.md)
- SQLite schema (`submissions`, `audit_events`) + migrations per [specs/audit.md](specs/audit.md)
- Submission API: `POST /submissions`, `GET /submissions/:id` per [specs/api.md](specs/api.md)
- Registry API: `GET /skills`, `GET /skills/:owner/:name`, download endpoint per [specs/registry-api.md](specs/registry-api.md)
- MD-only auto-approve workflow (creates PR, merges via system identity, publishes artifact)
- docker-compose dev stack (Forgejo + API + Web) per [specs/deployment.md](specs/deployment.md)

**Depends on**: nothing.

### Phase 2 — Approval Pipeline (Week 3–4)

**Goal**: A code-containing skill can be questionnaire'd, scanned, confirmed, approved, and published.

- Flowcraft integration with HITL nodes per [specs/workflow.md](specs/workflow.md)
- Scanner container image per [specs/security-scanning.md](specs/security-scanning.md)
- Optional LLM content screen (provider-pluggable; advisory + md-only gate) per [specs/security-scanning.md#llm-content-screening](specs/security-scanning.md#llm-content-screening)
- Questionnaire + confirmation + approve/reject endpoints per [specs/api.md](specs/api.md)
- Compliance approval UI flow (incl. Screening tab) per [specs/web-ui.md](specs/web-ui.md)
- Entra ID authentication (mock in dev, real in prod) per [specs/security.md](specs/security.md)
- Per-skill workflow mutex + crash-resume

**Depends on**: Phase 1 (uses the same Forgejo client, types, SQLite schema, web shell).

### Phase 3 — CLI & Registry Integration (Week 5–6)

**Goal**: External agents (Claude Code, Codex) discover and install skills via MCP and a marketplace repo.

- MCP server exposing registry as tools per [specs/mcp.md](specs/mcp.md)
- Marketplace Git repo sync on publish per [specs/cli-integration.md](specs/cli-integration.md)
- `asr login` device code flow per [specs/cli-integration.md](specs/cli-integration.md)
- Forgejo generic package registry wiring for skill artifacts

**Depends on**: Phase 2 (Entra ID + publish path must exist).

### Phase 4 — Hardening & Production (Week 7–8)

**Goal**: Production-ready on Azure with SLA discipline.

- Remaining scanners enabled (Veracode optional)
- SLA timeouts + notification emails
- Version diffing + yank flow per [specs/versioning.md](specs/versioning.md)
- External audit anchoring (signed Git tag job)
- Azure Container Apps deployment (Bicep templates) per [specs/deployment.md](specs/deployment.md)
- Penetration testing of zip upload path (process, not feature — captured as a checklist epic)
- Compliance officer documentation

**Depends on**: Phase 3.
