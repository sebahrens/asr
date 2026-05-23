# Web UI

React 19 + Vite 6 SPA living in `packages/web/`. Acts as the **registry browser** for everyone and the **approval dashboard** for compliance reviewers.

## Stack

- React 19, Vite 6, TypeScript strict
- React Router (data routers)
- Auth: `@azure/msal-react` (Authorization Code + PKCE) in prod, mock provider in dev
- Data fetching: `@tanstack/react-query` with the typed client generated from the OpenAPI dump of [api.md](api.md) + [registry-api.md](registry-api.md)
- Markdown: `react-markdown` + `remark-gfm` (no `rehype-raw`)
- Styling: CSS modules; design tokens in `packages/web/src/tokens.css` (colours, spacing, type scale)
- Testing: Vitest + Testing Library; Playwright for E2E (drives the dev stack — see [ralph-scripts/PROMPT_visual_review.md](../ralph-scripts/PROMPT_visual_review.md))

## Routes

| Path | Screen | Auth | Roles |
|------|--------|------|-------|
| `/` | Landing / Browse | optional | any |
| `/skills/:owner/:name` | Skill detail | optional | any |
| `/skills/:owner/:name/v/:version` | Pinned version detail | optional | any |
| `/submit` | New submission wizard | required | Submitter |
| `/submissions` | My submissions | required | Submitter |
| `/submissions/:id` | Submission detail (status, scan, audit timeline) | required | Submitter (own) or Compliance/Admin |
| `/review` | Approval queue | required | Compliance/Admin |
| `/review/:id` | Approval detail (diff, scan, decision) | required | Compliance/Admin |
| `/audit` | Audit explorer | required | Compliance/Admin |
| `/admin` | Tokens, scanners, system health | required | Admin |
| `/login` | Sign-in handoff to MSAL | none | n/a |
| `/error` | Friendly 4xx/5xx page | none | n/a |

Route protection is enforced both client-side (redirect to `/login` or `/error?code=403`) and server-side (every API call gates again). Client-side is UX only — never a security boundary.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│ Topbar:  asr logo | search | nav | user menu            │
├──────────┬──────────────────────────────────────────────┤
│ Sidebar  │ Page content                                  │
│ (sticky) │                                               │
│          │                                               │
│ Browse   │                                               │
│ Submit   │                                               │
│ Mine     │                                               │
│ Review*  │                                               │
│ Audit*   │                                               │
│ Admin*   │                                               │
│          │                                               │
└──────────┴──────────────────────────────────────────────┘
* visible only with the corresponding role
```

Responsive collapse: sidebar becomes a slide-out drawer below 900px.

## Key Screens

### Landing / Browse

- Search bar (debounced, calls `GET /skills?q=...`)
- Tag filter chips
- Result grid: name, owner, latest version, description, tags, kind badge, risk badge
- Empty state: "No skills match your search" + clear filters action
- Pagination via `nextCursor`

### Skill Detail

- Header: owner/name, latest version pill, install snippet (`asr install owner/name`)
- Tabs: SKILL.md preview · Versions · Permissions · Audit (if signed in)
- Markdown rendered via `react-markdown`; code blocks themed; tables styled; links open in new tab with `rel="noopener noreferrer"`
- Versions tab: list with yanked rows greyed-out + reason tooltip; diff link to compare any two versions

### Submission Wizard (`/submit`)

Four steps with progress indicator:
1. **Upload** — drag/drop zip; client-side validation (size, single root dir, manifest present)
2. **Manifest** — show parsed `manifest.yaml`, allow inline edit of description/tags, derive `kind`/`permissions` read-only
3. **Questionnaire** — render dynamic form from `GET /questionnaire/template`
4. **Review & Submit** — summarise; submit calls `POST /submissions` (multipart); on success redirect to `/submissions/:id`

Form validation messages appear inline next to fields, never via toast.

### Submission Detail (`/submissions/:id`)

- Status pill (uploaded · scanning · awaiting confirmation · pending review · approved · rejected · yanked)
- Timeline (audit events for this submission, newest first)
- Scan findings panel (collapsible per tool, severity-coloured)
- Action area depends on status + role:
  - `awaiting confirmation` + own submission → "Acknowledge findings" button
  - `pending review` + Compliance + submitter ≠ self → "Open in review" button

### Approval Detail (`/review/:id`)

- Header: skill name + version + risk badge
- Tabs:
  - **Diff** — split-pane file diff (uses `react-diff-viewer-continued`); pulls from `GET /skills/:owner/:name/versions/:version/diff`
  - **Dependencies** — table of added/removed/changed
  - **Permissions** — before/after JSON with expanded-capability lines highlighted red
  - **Scan** — full findings list, filterable by severity
  - **Audit** — chronological events
- Decision panel (sticky, right):
  - Comment textarea (required for reject, optional for approve)
  - **Approve** / **Reject** buttons; disabled if submitter `sub` == reviewer `sub` (separation of duties)
  - Confirmation modal repeats the version + risk before submitting

### Audit Explorer (`/audit`)

Tabbed search:
- By skill: `GET /audit/skill/:owner/:name`
- By submission: `GET /audit/submission/:id`
- By user: `GET /audit/user/:sub` (admin only)
- Chain integrity: `GET /audit/verify` (admin only; runs full-table verify, shows result banner)

## States to Cover Everywhere

Each screen must explicitly render the following states (Storybook stories required):

| State | UX |
|-------|----|
| Loading | Skeleton (not spinner) for content areas; topbar stays interactive |
| Empty | Helpful message + suggested next action |
| Error (4xx/5xx) | Inline error card with retry button; never blank screen |
| Forbidden | Friendly "you don't have access" with role hint |
| Offline | Toast at the top: "You're offline — viewing cached data" |
| Rate-limited | Inline banner with countdown to `Retry-After` |

## Auth UX

- Sign-in: redirect to MSAL `/login` then back to original route via `?returnTo=`
- Silent token refresh via MSAL's `acquireTokenSilent`; on failure, redirect to `/login`
- Dev/mock mode shows a persistent yellow banner: "Mock auth: <role>" so screenshots can't be confused with prod
- Tokens never appear in the DOM (no `data-token`, no JS-accessible cookie); access tokens live in MSAL's in-memory cache only

## Error UX

- The error boundary at the route root catches render errors → renders `/error` with a trace id
- API errors are normalised to `{ code, message, retryable }` and displayed inline; toast is reserved for transient success notices

## Accessibility

- WCAG 2.1 AA target
- Colour contrast ≥ 4.5:1 for body, ≥ 3:1 for large text
- Every interactive element keyboard-reachable; visible focus ring
- Status pills have text labels in addition to colour
- Forms use `aria-describedby` for validation messages

## Acceptance Tests (E2E)

These are the deterministic Playwright assertions the visual-review prompt drives:

1. Landing renders ≥ 1 skill in mock dev seed.
2. Skill detail SKILL.md preview renders headings, code blocks, tables.
3. Submission wizard rejects a zip > 50MB inline (no submit attempt).
4. Approval Decision is disabled when submitter `sub` == reviewer `sub`.
5. Yanked version appears in `/skills/:owner/:name` versions list with reason tooltip.
6. Audit Explorer surfaces an `audit.verify.failed` event if injected (mock mode).
7. No element in the DOM contains the string `ghp_`, `eyJ`, or any other token prefix.
8. The product name renders as **asr** across all screens; the strings `skify`, `json2pptx`, `github` MUST NOT appear in the rendered DOM.
