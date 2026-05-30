# LLM Skill Screening — Design

**Status:** Approved design (pre-implementation)
**Date:** 2026-05-30
**Owner:** platon2001
**Tracking epic:** to be filed in `bd` once this spec is approved (see "Tracking")

## 1. Goal

Add an optional, provider-pluggable LLM that reads the full extracted content of a
submitted `skill.zip` and verifies that the submitter's **declared statements** match
what the skill actually does, flagging inconsistencies for the compliance reviewer.

"Declared statements" are:

1. The `permissions` block in `SKILL.md` frontmatter — `network`, `networkHosts`,
   `filesystem`, `subprocess`, `environment` (`packages/core/src/manifest-schema.ts:5`).
2. The publish-wizard questionnaire answers — external-network yes/no, filesystem-access
   level, reviewer notes (`packages/web/src/App.tsx:981`).

Today nothing checks either against the actual code. The only content analysis is the
binary `md-only` vs `code-containing` classifier (`packages/submission/src/zip/classify.ts:18`);
declared permissions are author-asserted and only shape-validated by zod.

### Check scope (all four in scope)

| Category | What it flags |
|---|---|
| `permission` | Declared permissions vs. observed behavior (e.g. `network: false` but `fetch()`/sockets; `filesystem: none` but writes files; undeclared subprocess; undeclared env reads). |
| `questionnaire` | Publish-wizard answers that contradict the content. |
| `description` | `SKILL.md` description/tags that misrepresent what the skill does. |
| `malicious` | Data exfiltration, credential harvesting, obfuscated payloads, prompt-injection aimed at the consuming agent — semantic judgment the regex scanners can't make. |

## 2. Enforcement model

**Advisory for code-containing skills; a narrow fail-closed gate for md-only skills.**

- **Code-containing** skills already pass through questionnaire → scanner → human
  compliance review. The screen is **purely advisory** there: it attaches a report and
  never alters the pipeline's flow or verdict. An LLM false-positive cannot kill a
  legitimate submission.
- **Md-only** skills currently bypass the questionnaire *and* the scanner and go straight
  to `auto-approve → publish` with **no human in the loop** (`approvalPipeline.ts:161`).
  This is the one path the screen **gates**: a finding diverts the submission to
  compliance `review`; a clean result auto-approves as today. This does not contradict the
  advisory stance for code — it simply stops silent auto-publish of suspicious markdown.

This can be graduated to a soft/hard gate for code-containing skills later once the
screen's precision is trusted; that is explicitly out of scope for v1.

## 3. Activation & configuration

The screen runs **server-side in the submission backend** (Hono/Node). All credentials are
**runtime** env vars on that service, zod-validated in `packages/submission/src/env.ts`,
optional exactly like the existing `VERACODE_*` block. **No `VITE_*` involvement** — keys
must never reach the web bundle.

A provider selector is the master on-switch; two provider-specific credential sets support
four endpoint families.

| Var | Role |
|---|---|
| `LLM_SCREEN_PROVIDER` | `openai` \| `anthropic`. **Unset → screening disabled** (status `skipped`). |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Used when provider=`openai`. Base-URL override covers **any OpenAI-compatible** endpoint (Azure OpenAI, OpenRouter, LiteLLM in OpenAI mode, local servers). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | Used when provider=`anthropic`. Base-URL override covers **Anthropic-compatible** proxies (corporate LiteLLM → Claude on Bedrock). |
| `LLM_SCREEN_CONTEXT_TOKENS` | Chosen model's context window (e.g. `200000`…`1000000`). Default `200000`. |
| `LLM_SCREEN_RESERVE_OUTPUT_TOKENS` | Headroom reserved for the rubric + JSON response. Default `8000`. |
| `LLM_SCREEN_CHARS_PER_TOKEN` | Conservative estimate ratio for budget packing. Default `3.5`. |

### Validation rules (zod, `env.ts`)

- `LLM_SCREEN_PROVIDER=openai` ⇒ `OPENAI_API_KEY` and `OPENAI_MODEL` required.
- `LLM_SCREEN_PROVIDER=anthropic` ⇒ `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` required.
- Base URLs optional (provider SDK default when unset).
- `LLM_SCREEN_CONTEXT_TOKENS` / `_RESERVE_OUTPUT_TOKENS` positive integers.
- The whole feature stays **optional in production** (not added to the prod required-env
  list). When unset, the pipeline behaves exactly as it does today.

Why `LLM_SCREEN_CONTEXT_TOKENS` is declared rather than auto-detected: behind LiteLLM /
Bedrock / OpenRouter the model id is opaque and no reliable window-lookup exists. It is
explicit config with a safe 200k default; bump it to 1M when pointing at a 1M-context model.

### Compose wiring (dev/test) — provider-neutral

The `api` service already interpolates host env (`FORGEJO_UPLOAD_TOKEN=${FORGEJO_ADMIN_TOKEN:-}`,
`docker-compose.yml:37`). Screening follows the same pattern with **empty defaults** so the
feature is off unless the operator exports values. Nothing provider-specific is committed:

```yaml
# deploy/docker/docker-compose.yml — api service environment:
- LLM_SCREEN_PROVIDER=${LLM_SCREEN_PROVIDER:-}
- OPENAI_API_KEY=${OPENAI_API_KEY:-}
- OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
- OPENAI_MODEL=${OPENAI_MODEL:-}
- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
- ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}
- ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-}
- LLM_SCREEN_CONTEXT_TOKENS=${LLM_SCREEN_CONTEXT_TOKENS:-200000}
```

The key reaches the **running** container as a runtime `environment:` entry interpolated
from the host shell — never baked into an image layer.

Per-machine mappings live only in the operator's shell or a gitignored `.env`, documented
as **examples** in a committed `.env.example` (none authoritative):

```bash
# .env.example — pick ONE, set in your shell or a gitignored .env

# OpenRouter (OpenAI-compatible) — e.g. local dev on this machine
LLM_SCREEN_PROVIDER=openai
OPENAI_API_KEY=${OPENROUTER_API_KEY}        # mapped from your existing shell var
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=anthropic/claude-3.7-sonnet
LLM_SCREEN_CONTEXT_TOKENS=200000

# Azure OpenAI (OpenAI-compatible)
# LLM_SCREEN_PROVIDER=openai
# OPENAI_API_KEY=...
# OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment>
# OPENAI_MODEL=<deployment>

# Corporate LiteLLM → Claude on Bedrock (Anthropic-compatible)
# LLM_SCREEN_PROVIDER=anthropic
# ANTHROPIC_API_KEY=...
# ANTHROPIC_BASE_URL=https://litellm.corp.internal
# ANTHROPIC_MODEL=anthropic.claude-3-7-sonnet
# LLM_SCREEN_CONTEXT_TOKENS=1000000
```

## 4. Pipeline placement & control flow

A single screening core (`runScreening`) wired into the Flowcraft graph
(`packages/submission/src/workflow/approvalPipeline.ts`) at two points with different
downstream semantics. Both nodes call the same core; only their edges differ.

```
classify → push-to-forgejo
  ├─(code-containing)→ questionnaire → scan ─(continue)→ screen ───────────────→ confirmation → review → publish
  │                                     └─(block)────────────────────────────→ rejected
  └─(md-only)──────→ screen-md ─(clean)→ auto-approve → publish
                              └─(flagged|error)→ review
```

- **Code path:** `scan --continue--> screen --> confirmation`. `screen` always falls
  through to `confirmation` (advisory). The scanner's `block → rejected` edge is untouched;
  the screen only runs on submissions the scanner already let continue.
- **Md-only path:** `push-to-forgejo --md-only--> screen-md`, then
  `screen-md --clean--> auto-approve` and `screen-md --flagged--> review`. Runs **before**
  publish so a flagged markdown skill never merges.

### Degradation / failure behavior

| Condition | Code-containing | Md-only |
|---|---|---|
| Screening unconfigured | status `skipped`, → confirmation | status `skipped`, → auto-approve (today's behavior) |
| LLM error / timeout | status `error`, advisory "screen unavailable — manual review advised", → confirmation (already human-bound) | status `error`, **fail closed** → `review` |
| Content over token budget | `truncated` finding added; still advisory | `truncated` treated as a finding → `review` |

The screening function is injected into the pipeline dependencies (same pattern as
`runScanner` being injected via `RunContainer`) so tests never hit the network.

## 5. Components & data model

### New module: `packages/submission/src/screen/`

- `runScreening.ts` — orchestrator. Input `{ extractedDir, manifest, questionnaire?, classification, submissionId, contentHash }`; packs content, calls the provider, maps raw output to a `ScreeningReport`. Takes an **injectable provider** (the test seam).
- `packContent.ts` — walks `extractedDir`, skips binaries/images by extension, includes text/code files with `path:line` headers (so findings can cite locations), and stops at the derived token budget. Overflow sets `truncated: true` and emits a finding.
- `providers/types.ts` — `ScreeningProvider { name; contextTokens; complete(system, userContent): Promise<RawFinding[]> }`.
- `providers/openai.ts` — `openai` SDK; structured output via `response_format` JSON schema; relies on OpenAI/Azure/OpenRouter/LiteLLM **automatic prefix caching** (static rubric placed first in the prompt).
- `providers/anthropic.ts` — `@anthropic-ai/sdk`; structured output via a **forced tool call**; explicit `cache_control: { type: 'ephemeral' }` on the system rubric (Anthropic caching is opt-in, unlike OpenAI's automatic prefix cache).
- `providers/factory.ts` — builds the provider from env; the single injectable seam.
- `prompt.ts` — static system rubric (cacheable, placed first) describing the four check categories and the required JSON/tool output shape; plus the per-skill user content (declared permissions + questionnaire answers + packed files).

### Token-budget packing

```
contentBudgetTokens = LLM_SCREEN_CONTEXT_TOKENS
                    − estimatedSystemRubricTokens
                    − LLM_SCREEN_RESERVE_OUTPUT_TOKENS
                    − safetyMargin
```

Token counts are estimated from byte/char length via `LLM_SCREEN_CHARS_PER_TOKEN`
(conservative, configurable) — robust across providers without shipping per-model
tokenizers. Exact tokenization is a possible later enhancement.

### Canonical types — `@asr/core` (never redefined elsewhere, per project hard rule)

```ts
export type ScreeningCategory = 'permission' | 'questionnaire' | 'description' | 'malicious';
export type ScreeningStatus = 'clean' | 'flagged' | 'skipped' | 'error';

export interface ScreeningFinding {
  category: ScreeningCategory;
  severity: ScanSeverity;          // reuse existing 'critical'|'high'|'medium'|'low'
  file?: string;
  line?: number;
  declared?: string;               // e.g. "network: false"
  observed?: string;               // e.g. "fetch('https://...') in scripts/run.sh:12"
  message: string;
}

export interface ScreeningReport {
  submissionId: string;
  contentHash: string;
  provider: 'openai' | 'anthropic';
  model: string;
  contextTokens: number;
  status: ScreeningStatus;
  truncated: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  findings: ScreeningFinding[];
}
```

The report is stored on the workflow context (`screeningReport?` on
`ApprovalPipelineContext`) and persisted alongside the scan report.

## 6. Surfacing & audit

- **Review UI** (`packages/web/src/routes/ReviewDetail.tsx`): a new **"Screening" tab**
  beside the existing Diff and Scan tabs. Each finding renders as declared-vs-observed,
  e.g. *"Permissions — declared `network: false`, observed `fetch()` in `scripts/run.sh:12`"*.
  Read-only; advisory. Shows `skipped`/`error`/`truncated` states explicitly.
- **Audit**: emit via `audit.emit` with a **new closed-enum action** `screening.completed`.
  This requires adding the action to `AUDIT_ACTIONS` (the enum is closed by hard rule;
  this is the one place the closed set is extended). Detail records provider, model,
  status, finding count, truncated.

## 7. Testing

Two tiers, both reading the **same env contract** the service uses.

- **Unit (always-on, no network):** inject a fake `ScreeningProvider` returning canned
  structured findings. Covers `packContent` (binary skip, budget/truncation), env
  activation/skip/required-model validation, report→action mapping (advisory vs md-only
  gate), and fail-closed-on-error for md-only. Runs in CI with no key.
- **Integration smoke (auto-gated, provider-agnostic):** `describe.skipIf(!screeningConfigured(env))`,
  keyed on "provider + matching key present" — **not** on any specific provider's var. Runs
  a real call through the configured provider against two fixtures: an **honest** skill and
  a **lying** one (`network: false` in frontmatter but `fetch()` in a script), asserting
  `clean` vs `flagged`. Self-skips when no provider is configured (CI stays green). Lives in
  the `pnpm test:e2e` smoke suite. On this machine it is run against OpenRouter; elsewhere
  against whatever the env points to.

## 8. Efficiency

- One LLM call per submission.
- Static rubric placed first → automatic prefix caching (OpenAI/compat) or explicit
  ephemeral cache (Anthropic); only per-skill content billed fresh.
- Binaries/images skipped; content sized to the model's real window (200k–1M).
- The ingest path already rejects duplicate `contentHash` upstream
  (`packages/submission/src/http/submissions.ts`), so identical resubmissions never re-screen.

## 9. Out of scope (v1)

- Graduating code-containing screening from advisory to a soft/hard gate.
- Exact per-model tokenization (estimate-based budget for now).
- Map-reduce / per-file screening of very large skills (single capped call only).
- Auto-detecting model context windows.
- Reconciling/auto-correcting the declared manifest from findings (reviewer acts manually).

## 10. Affected files (anticipated)

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `ScreeningCategory`/`ScreeningStatus`/`ScreeningFinding`/`ScreeningReport`. |
| `packages/core/src/index.ts` | Export new types. |
| `packages/core/src/audit.ts` (+ `AUDIT_ACTIONS`) | Add `screening.completed` action. |
| `packages/submission/src/env.ts` | Add + validate screening env vars. |
| `packages/submission/src/screen/**` | New module (orchestrator, packing, providers, prompt). |
| `packages/submission/src/workflow/approvalPipeline.ts` | Add `screen` / `screen-md` nodes + edges + context field + injected dependency. |
| `packages/submission/src/workflow/*Node*` | New screen node implementations. |
| Persistence (workflow record / DB) | Store `screeningReport` alongside `scanReport`. |
| `packages/web/src/routes/ReviewDetail.tsx` | New "Screening" tab. |
| `deploy/docker/docker-compose.yml` | Provider-neutral screening env interpolation on `api`. |
| `.env.example` (new) | Documented provider examples (OpenRouter / Azure / LiteLLM). |
| `package.json` (submission) | Add `openai`, `@anthropic-ai/sdk` deps. |
| Tests | Unit (fake provider) + gated integration smoke + fixtures (honest/lying skills). |

## 11. Tracking

On approval, file a `bd` epic + atomic tasks (`tier:epic` / `tier:task`) covering: core
types + audit action; env + validation; provider abstraction (openai, anthropic, factory);
content packing + token budget; runScreening orchestrator; pipeline wiring (code advisory +
md-only gate); persistence; Screening tab UI; compose + `.env.example`; unit tests; gated
integration smoke + fixtures.
