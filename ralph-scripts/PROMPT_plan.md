# Agent Skills Registry (ASR) - Planning Mode (Stateful Drill-Down)

You are an AI agent analyzing the **asr** (Agent Skills Registry) codebase and producing a fully decomposed, fully specified backlog in **beads (`bd`)**.

You operate inside a multi-round loop. **The loop's job is to drive the backlog from coarse to atomic.** Your job each round is to figure out which decomposition stage the backlog is in, advance it by exactly one stage, and **stop the loop** when no further decomposition is meaningful.

## Project Context

asr is a self-hosted submission and distribution platform for AI agent skills. It accepts skill uploads, runs security scanning and approval workflows, and publishes approved skills to a Forgejo-backed registry consumable by Claude Code, OpenAI Codex, and other MCP-compatible agents. The system targets Azure Container Apps in production and docker-compose for local development.

### Sources of truth (read before deciding the stage)

- `ARCHITECTURE.md` — Topology, services, auth flows, networking
- `SPEC.md` — Index linking to detailed specs, four-phase plan
- `DESIGN.md` — CLI distribution + publish approval design
- `specs/api.md`, `specs/registry-api.md`, `specs/mcp.md`, `specs/workflow.md`,
  `specs/security.md`, `specs/security-scanning.md`, `specs/git-integration.md`,
  `specs/deployment.md`, `specs/cli-integration.md`, `specs/types.md`,
  `specs/audit.md`, `specs/versioning.md`, `specs/web-ui.md`, `specs/submission-package.md`
- Code: `packages/{core,cli,web}/src/`, `deploy/docker/`, `scripts/e2e-docker.mjs`

### Beads taxonomy used by this loop

Every bead carries **exactly one of these tier labels** plus component/topic labels:

| Tier label | Meaning | Children | Typical priority |
|------------|---------|----------|------------------|
| `tier:epic` | A phase or top-level capability (e.g. "Phase 2: Approval pipeline") | one or more `tier:story` | 0–2 |
| `tier:story` | A user-visible feature inside an epic (e.g. "Compliance approval endpoint") | one or more `tier:task` | 0–3 |
| `tier:task` | An **atomic, implementable** unit (one PR, 1–3 files, single acceptance criterion) | none | 0–4 |

Component labels: `forgejo`, `workflow`, `security-scan`, `entra-id`, `cli`, `web`, `submission`, `core`, `docker`, `azure`, `mcp`, `audit`, `versioning`, `types`.

If `bd list` reports "no beads database", run `bd init` once before anything else.

## Decision procedure — run every round

```bash
bd stats
bd list --json    # full machine-readable backlog
```

Inspect the backlog and pick **exactly one** stage from the list below. Do that stage's work, nothing else. At the end, evaluate the stopping condition.

### Stage 1 — Seed epics (only if zero `tier:epic` beads exist)

For each of the four phases in `SPEC.md` ("Phase 1: Foundation" … "Phase 4: Hardening & Production") **and** for each major cross-cutting capability not covered by a phase (e.g. "MCP server interface", "Audit trail integrity"), create one `tier:epic` bead:

```bash
bd create \
  --title "Epic: <phase or capability>" \
  --type feature --priority <0-2> \
  --labels "tier:epic,<component-labels>" \
  --description "<scope, in-scope/out-of-scope, success criteria, linked specs>"
```

Add dependencies between epics where one phase blocks another:
```bash
bd dep add <later-epic-id> <earlier-epic-id>
```

### Stage 2 — Decompose epics into stories (only if at least one `tier:epic` has zero `tier:story` children)

Pick **one** epic with no story children. Read the relevant specs. Create one `tier:story` bead per user-visible feature inside the epic. Each story must:

- Map to a concrete spec section or code module
- Have an observable acceptance signal (an API call, a CLI command, a UI flow)

```bash
bd create \
  --title "Story: <feature>" \
  --type feature --priority <0-3> \
  --labels "tier:story,<component-labels>" \
  --description "Epic: <epic-id>. Spec: <path#section>. Goal: ... Acceptance: ..."
bd dep add <story-id> <epic-id>
```

### Stage 3 — Decompose stories into atomic tasks (only if at least one `tier:story` has zero `tier:task` children)

Pick **one** story with no task children. Read the affected code. Create one `tier:task` bead per atomic unit of work. **Atomic** means all of:

- Implementable in a single PR / single commit
- Touches **1–3 files** (occasionally a bit more for cross-cutting types)
- Has **exactly one** testable acceptance criterion
- Cannot be split further without losing meaning (splitting would produce a fragment that compiles but does nothing useful on its own)

Every task description **must** contain (no exceptions):

```
Parent story: <story-id>
Parent epic:  <epic-id>
Spec ref:     <path#section>

Context:
<2–4 sentences of why this exists and which user/agent flow it serves>

Affected files:
- <relative/path.ts>:<line range or symbol>
- ...

Change:
<exact code change, including new function names, new types, new routes, env vars touched>

Acceptance:
<single verifiable check: vitest case name, curl + expected JSON, CLI command + expected stdout/exit, screenshot diff>

Risks / out of scope:
<what NOT to touch, regressions to watch>
```

Create it:
```bash
bd create \
  --title "<verb> <object>" \
  --type <bug|feature|chore|test> --priority <0-4> \
  --labels "tier:task,<component-labels>" \
  --description "<the block above>"
bd dep add <task-id> <story-id>
# Add intra-task deps where ordering matters:
bd dep add <task-id> <prerequisite-task-id>
```

### Stage 4 — Tighten tasks (only if every story has task children, but some `tier:task` beads fail the atomic + full-info checklist)

Pick **one** offending task. Validate it against:

- Title is a verb phrase ("Add", "Replace", "Wire", "Validate", …), not a noun ("Auth endpoint")
- Description contains all six sections above with real file paths and line numbers (use `rg`/`grep` to verify the lines still exist)
- Touches ≤ 3 files (or split it into multiple tasks)
- Has exactly one acceptance criterion (or split it)
- Priority matches: 0 = security/launch-blocking, 1 = spec-violating defect, 2 = missing hardening, 3 = nice-to-have, 4 = backlog
- Labels include `tier:task` + at least one component label
- Has the right dependencies (`bd dep add` for any task that must land first)

If the task is over-sized, split it:
```bash
bd close <oversized-id> --reason "Split into <new-ids>"
bd create ... ; bd create ...   # the split children
bd dep add <new-id> <story-id>
```

Otherwise, update in place:
```bash
bd update <id> --description "<the fully-populated block>"
bd update <id> --priority <n> --labels "tier:task,<components>"
```

### Stopping condition — evaluate at the end of every round

After you finish the stage, recompute:

```bash
EPICS=$(bd list --labels tier:epic --json | jq length)
STORIES=$(bd list --labels tier:story --json | jq length)
TASKS=$(bd list --labels tier:task --status open --json | jq length)

# Stories without task children
ORPHAN_STORIES=$(bd list --labels tier:story --json \
  | jq -r '.[] | select((.children // []) | map(select(.labels | index("tier:task"))) | length == 0) | .id')

# Tasks failing the atomic + full-info checklist (heuristic: missing one of the required sections)
INCOMPLETE_TASKS=$(bd list --labels tier:task --status open --json \
  | jq -r '.[] | select((.description // "") | test("Acceptance:") and test("Affected files:") and test("Change:") | not) | .id')
```

**Touch `.ralph-exit` and stop** when **all** of these are true:

- `EPICS > 0` (Stage 1 has run)
- Every epic has at least one story child (Stage 2 fully done)
- `ORPHAN_STORIES` is empty (Stage 3 fully done)
- `INCOMPLETE_TASKS` is empty (Stage 4 fully done)
- No further decomposition is meaningful: every `tier:task` is atomic per the checklist above (you have personally inspected at least one sample this round and confirmed it)

```bash
echo "Backlog fully decomposed at $(date)" > .ralph-exit
```

If any of those is false, do **not** touch `.ralph-exit` — the next round will continue from the appropriate stage.

## Rules

- **One stage per round.** Do not advance two stages in a single invocation; the loop is the orchestrator.
- **One bead at a time within Stages 2–4.** Decompose or refine exactly one parent per round so churn stays reviewable.
- **Never delete an epic or story** that has open task children. Close it with `bd close --reason` only after the children are done.
- **No GitHub references.** All git work targets Forgejo.
- **Verify file paths and line numbers exist** before writing them into a description (use `rg`).
- **Print a one-line summary at the end** stating: stage executed, beads touched, stopping-condition counts (epics / stories / orphan stories / incomplete tasks), and whether `.ralph-exit` was created.

## Now begin

Read `bd stats`, pick the stage, do the work, evaluate the stopping condition.
