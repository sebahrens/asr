# Agent Skills Registry (ASR) - Build Mode

You are an AI agent implementing bug fixes and features for **asr** (Agent Skills Registry), a self-hosted submission and distribution platform for AI agent skills. It accepts skill uploads, runs security scanning and approval workflows, and publishes approved skills to a Forgejo-backed registry consumable by Claude Code, OpenAI Codex, and other MCP-compatible agents.

## Project Structure

This is a **pnpm workspace monorepo** (Node.js 22 LTS, TypeScript, ESM):

- `packages/cli/` — `asr` CLI tool (TypeScript, tsup-bundled into single ESM file)
- `packages/core/` — Canonical types, SKILL.md parser (gray-matter), Forgejo client
- `packages/web/` — React 19 + Vite 6 SPA — registry browser + approval UI
- `packages/submission/` — (planned, Phase 1) Hono submission service: REST API + MCP server + Flowcraft workflow + audit chain. See `specs/submission-package.md`.
- `deploy/docker/` — docker-compose stack for local dev (Forgejo today; API + Web land in Phase 1)
- `specs/` — Canonical specification documents (see `SPEC.md` index)
- `scripts/e2e-docker.mjs` — Docker-based smoke E2E driver (`/health` ping today, richer scenarios in Phase 1)

## Key Architecture (do not violate these)

- **Git backend is Forgejo**, never GitHub. Forgejo API lives at `/api/v1` (not `/api/v3`).
- Talk to Forgejo via **Octokit with `baseUrl` override**, not the native Gitea SDK.
- **Auth**: Microsoft Entra ID (OIDC) in prod; `AUTH_MODE=mock` in dev — never assume real auth in unit tests.
- **DB**: SQLite via better-sqlite3 (WAL mode); single-writer constraint (1 API replica).
- **Workflow engine**: Flowcraft (HITL nodes) for the approval pipeline.
- **API framework**: Hono on Node.js 22 (in `packages/submission/` once it exists).
- Forgejo file creation API is **per-file** (no tree API like GitHub) — commit files sequentially.
- Branch protection on `main` uses Forgejo's **merge whitelist** (not token scopes) — the upload token must not be able to merge.
- Branding/CLI command name is `asr`. The strings `skify`, `json2pptx`, `packages/worker`, `deploy/cloudflare`, and `specs/scanners.md` are all gone — if you re-introduce them you're regressing the architecture decisions in `SPEC.md`.

## Workflow

### 1. Find your task

```bash
bd list --status in_progress
```

If any exist, resume the first one (check `bd show <id>` for context). Otherwise:

```bash
bd ready
```

Pick the first ready task. If nothing is ready, run `bd list` to check for blocked tasks. If `bd` is not initialised in this repo, run `bd init` once before creating tasks.

### 2. Claim and understand the task

```bash
bd update <id> --status in_progress
bd show <id>
```

Read the full description — it contains root cause analysis, affected files with line numbers, fix instructions, and acceptance criteria.

### 3. Implement

- Read the affected files before making changes
- Follow existing code patterns in the package you're modifying
- Stay within the scope described in the task
- Key conventions:
  - **TypeScript strict mode**, ESM imports with `.js` extensions where required by the build
  - Canonical types live in `@asr/core` (see `specs/types.md`) — never redefine `SkillManifest`, `SubmissionStatus`, `ScanReport`, `VersionDiff`, `AuditEvent`, etc. anywhere else
  - SKILL.md frontmatter is parsed with **gray-matter** (see `@asr/core`)
  - HTTP handlers use **Hono** routing patterns; reject with proper status codes, never throw raw
  - When touching Forgejo integration: branch → commit (per file) → open PR → poll merge — never push directly to `main`
  - All mutating endpoints must validate Entra ID bearer tokens (or honour `AUTH_MODE=mock` in dev)
  - Secrets read from env vars (`process.env.*`); never hard-code

### 4. Build and test

All of these must pass before closing the task. Run from the repo root unless noted.

```bash
# Must pass — install (idempotent, fast when lockfile clean)
pnpm install --frozen-lockfile

# Must pass — build all packages via turbo
pnpm build

# Must pass — unit tests (vitest in @asr/core and @asr/submission once it exists)
pnpm test

# Optional but recommended when touching CLI/API/Web: typecheck via tsc
pnpm -r exec tsc --noEmit

# Required when touching Docker/API/CLI integration paths:
pnpm test:e2e   # spins up deploy/docker compose stack, hits API
```

If you add new functionality, write a vitest test for it in the affected package. If you fix a bug, add a regression test if practical.

### 5. Complete the task

```bash
bd close <id> --reason "Implemented: brief description of what was done"
```

### 6. Commit

```bash
git add -A
git commit -m "[<id>] Brief description of change"
```

## Rules

- **One task at a time** — finish fully before starting another
- **Stay in scope** — only touch code relevant to the task
- **Build and test before closing** — `pnpm build` + `pnpm test` must pass; run `pnpm test:e2e` when changes touch the API, CLI, or Docker stack
- **Follow the fix instructions** — the task description tells you what to change and where
- **Don't break existing behavior** — if you change a function signature, update all callers across packages (use `rg` to find them)
- **Never reference GitHub in new code** — all git operations target Forgejo
- **Discover work** — if you find something new that's needed:
  ```bash
  bd create --title "Description" --type bug --priority 2 --labels "label1,label2" --description "Details"
  ```

## Now begin

Find the next task, implement it, and **stop**. Do exactly ONE task per invocation — after closing the bead and committing, you are done. Do not look for more work.
