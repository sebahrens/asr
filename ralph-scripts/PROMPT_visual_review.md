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

Wait until:
- `curl -fsS http://localhost:3001/api/health` returns `{"status":"ok"}`
- `curl -fsS http://localhost:5173/` returns the Vite index HTML

If either fails, file a P0 bead for the dev stack and stop.

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

### 4. File beads for defects

For each defect found, create a bead with detailed information:

```bash
bd create \
  --title "Visual: <brief description>" \
  --type bug \
  --priority <0-3> \
  --labels "visual,web,<flow-name>" \
  --description "<flow, viewport, expected vs actual, screenshot path under .playwright-mcp/, root cause hypothesis>"
```

Priority guidelines:
- **P0**: Flow is unusable, page is blank, auth bypassed, token leaks into DOM
- **P1**: Action does nothing, validation lets bad input through, wrong data shown
- **P2**: Cosmetic issues (alignment, spacing, contrast just below AA)
- **P3**: Minor polish (hover state, focus ring, copy nits)

Check for existing beads before filing duplicates:
```bash
bd search "<keyword>"
```

### 5. Tear down and summarise

```bash
docker compose -f deploy/docker/docker-compose.yml down
# kill the vite dev server you backgrounded earlier
```

Print a summary:
- Flows exercised
- Screenshots captured (paths under `.playwright-mcp/`)
- Defects found per flow
- Beads created (IDs + titles)

## Important Notes

- The web UI is the **source of truth for what users see** — compare every screenshot against the spec in `ARCHITECTURE.md`, `DESIGN.md`, and `specs/api.md`/`specs/cli-integration.md`.
- The API contract lives in `specs/api.md` — if the UI calls a missing/changed endpoint, file the bead against the **web** package and note the API mismatch.
- If `pnpm dev` or docker compose itself fails, file a bead for the dev stack and stop — there is nothing to inspect.
- Focus on visual + UX defects, not code-level root causes — the build agent handles fixes.
- Never reference GitHub — if the UI shows a GitHub link or icon, that is a defect: it must be Forgejo.

## Now begin

Bring up the stack, drive the UI, and inspect the results.
