# Agent Skills Registry (ASR) - Visual Review Mode

You are an AI agent performing visual quality inspection of the **@asr/web** registry browser + approval UI.

## Goal

Bring up the local dev stack, drive the React SPA through its core flows with Playwright (via the `playwright` MCP server), capture screenshots, and file beads for any visual or UX defects found.

## Workflow

### 1. Bring the stack up

```bash
# From the repo root
docker compose -f deploy/docker/docker-compose.yml up -d   # Forgejo + API
pnpm --filter @asr/web dev &                                # Web on http://localhost:5173
```

If the Docker daemon or socket is unavailable, use the checked-in mock API
instead of stopping the visual review:

```bash
pnpm dev:api &                                               # Mock API on http://localhost:3001
pnpm --filter @asr/web dev &                                # Web on http://localhost:5173
```

Wait until:
- `curl -fsS http://localhost:3001/api/health` returns `{"status":"ok"}`
- `curl -fsS http://localhost:5173/` returns the Vite index HTML

If both the Docker stack and the mock API fallback fail, file a P0 bead for the
dev stack and stop.

### 2. Drive the UI via Playwright MCP

Use the `playwright` MCP tools to navigate, interact, and screenshot. Save artefacts under `.playwright-mcp/` (already gitignored). For each of the flows below, capture before/after screenshots and a short note of what you observed.

Flows to exercise (covers `packages/web/src/App.tsx`):

1. **Landing / browse**: load `/`, confirm skill list renders, search bar visible, filter chips work.
2. **Skill detail**: click into a skill, verify SKILL.md preview renders via `react-markdown` + `remark-gfm` (headings, code blocks, tables).
3. **Auth (mock mode)**: confirm the mock identity banner shows in dev; the login button should be hidden or labelled "Mock".
4. **Submission**: open the publish/upload flow if exposed; verify form validation states (empty title, oversize zip, bad SKILL.md).
5. **Approval dashboard**: navigate to the approvals view (compliance role); verify pending submissions list, status pills, and the approve/reject actions render.
6. **Empty + error states**: trigger an API 404/500 (e.g. open `/skills/does-not-exist`) and verify the UI shows a graceful error, not a blank screen or stack trace.

### 3. Check for defects

For each captured screenshot, check:

- **Layout integrity**: no overlapping elements, no horizontal scroll on a 1280×800 viewport, footer pinned correctly, sidebar collapses on narrow widths.
- **Typography**: readable font sizes, no text clipping, consistent heading hierarchy, sufficient line-height.
- **Color & contrast**: WCAG AA contrast for body text, hover/focus states visible, status pills (pending/approved/rejected) use distinct, accessible colors.
- **Markdown rendering**: code blocks have monospace font + background; tables have borders; lists are indented; links are styled.
- **Loading & empty states**: spinners or skeletons appear during fetches; empty lists show a helpful message, not a blank pane.
- **Error states**: 4xx/5xx responses render an inline error message with retry, never a white screen of death.
- **Forms**: required-field hints visible, submit button disabled while invalid, validation messages tied to the right field.
- **Auth UX**: mock/dev mode is clearly labelled so it's never confused with prod; tokens never leak into the DOM.
- **Branding**: product name renders as **asr** (not `skify` or `json2pptx` — those are legacy names to be removed if found).

### 4. File or update beads for defects — DEDUP IS MANDATORY

Every visual defect maps to exactly one **defect category** from the fixed taxonomy below.
The category label — not the title wording — is the dedup key. NEVER file a new free-text
bug for a defect that fits an existing category: reworded titles are how this backlog filled
with hundreds of duplicates of the same ~14 defects.

**Canonical defect taxonomy** (`defect:<category>` → meaning):

- `defect:branding` — product name/logo shows anything other than **asr** (PwC, Skill Registry, Agent Skill Registry, json2pptx, skify)
- `defect:browse-filters` — browse page missing working tag/kind/risk filter chips
- `defect:browse-cards` — skill cards open a modal / are pointer-only divs instead of routing to detail, or omit kind/risk badges
- `defect:form-validation` — publish/upload Continue/Submit stays enabled while the form is invalid, or required fields fail silently
- `defect:sticky-header` — validation scroll lets the sticky header/topbar overlap form content
- `defect:wizard-steps` — publish wizard highlights/permits steps that should be locked while the current step is invalid
- `defect:diff-clipping` — review/approval diff or code text is clipped (mobile or desktop)
- `defect:responsive-nav` — layout lacks the sidebar / mobile drawer collapse behaviour
- `defect:markdown-gfm` — SKILL.md preview doesn't render GFM tables / fenced code / borders
- `defect:mock-auth` — mock/dev auth banner is wrong, conflicting, clips branding, or hides publish/review flows
- `defect:review-validation` — review detail shows a rejection error/warning before the user acts
- `defect:not-found` — unknown skill/review route renders browse instead of a 404/error state
- `defect:upload-input` — upload dropzone exposes native file-input chrome / "no file chosen" after a valid pick
- `defect:install-snippet` — skill detail shows an obsolete `asr add` install command
- `defect:other` — a genuinely new defect that fits NONE of the above (describe precisely)

**Before filing anything**, run the dedup gate for the defect's category:

```bash
CAT="defect:<category>"                                 # pick from the taxonomy
bd list --type bug --label "$CAT" --status open   --limit 0   # already tracked?
bd list --type bug --label "$CAT" --status closed --limit 5   # fixed before?
```

Then act on the result:

- **An OPEN bead with that category exists** → do NOT create a new one. Attach evidence:
  `bd update <id> --append-notes "Still present <date>: <flow>/<viewport>, screenshot <path>"`
- **The newest bead with that category is CLOSED but the defect is still visible** → the fix
  didn't stick; REOPEN it instead of re-filing:
  `bd reopen <id> -r "Still visible in visual review <date> — fix regressed or never landed"`
  then `bd update <id> --append-notes "<evidence>"`
- **No bead with that category exists** → create exactly one (only `defect:other` should ever
  be genuinely new):

```bash
bd create \
  --title "Visual: <brief description>" \
  --type bug \
  --priority <0-3> \
  --labels "tier:task,visual,web,<flow-name>,defect:<category>" \
  --description "<flow, viewport, expected vs actual, screenshot path under .playwright-mcp/, root cause hypothesis>"
```

Two labels are REQUIRED on every visual bug:
- `tier:task` — without it the build loop never selects the bug, so it can only ever be
  re-filed, never fixed. This is what lets the build phase actually close these out.
- `defect:<category>` — the dedup key; the gate above relies on it.

Priority guidelines:
- **P0**: Flow is unusable, page is blank, auth bypassed, token leaks into DOM
- **P1**: Action does nothing, validation lets bad input through, wrong data shown
- **P2**: Cosmetic issues (alignment, spacing, contrast just below AA)
- **P3**: Minor polish (hover state, focus ring, copy nits)

### 5. Tear down and summarise

```bash
docker compose -f deploy/docker/docker-compose.yml down  # only if Docker was used
# kill the vite dev server and mock API server you backgrounded earlier
```

Print a summary:
- Flows exercised
- Screenshots captured (paths under `.playwright-mcp/`)
- Defects found per flow
- Beads created (IDs + titles)

## Important Notes

- The web UI is the **source of truth for what users see** — compare every screenshot against the spec in `ARCHITECTURE.md`, `DESIGN.md`, and `specs/api.md`/`specs/cli-integration.md`.
- The API contract lives in `specs/api.md` — if the UI calls a missing/changed endpoint, file the bead against the **web** package and note the API mismatch.
- If `pnpm dev`, docker compose, and the mock API fallback all fail, file a bead for the dev stack and stop — there is nothing to inspect.
- Focus on visual + UX defects, not code-level root causes — the build agent handles fixes.
- Never reference GitHub — if the UI shows a GitHub link or icon, that is a defect: it must be Forgejo.

## Now begin

Bring up the stack, drive the UI, and inspect the results.
