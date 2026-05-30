# Workflow Engine

## Engine Choice: Flowcraft

- Zero runtime dependencies (~225KB)
- Native HITL (Human-in-the-Loop) nodes — pause/resume on external signals
- SQLite history adapter for durable state
- DAG-based blueprints (declarative, serializable)
- MIT license

Repository: https://github.com/gorango/flowcraft

## Pipeline

**Both** the auto-approve path and the full approval path push to Forgejo so the Git history is the single source of truth for every published artifact. The auto-approve path differs only in skipping the questionnaire/scan/confirmation/review nodes. When the optional LLM screen is configured, the md-only path passes through a `screen-md` gate that can divert a suspicious markdown skill to compliance review instead of auto-publishing (its one and only human checkpoint).

```
                 ┌────────────┐
                 │ uploaded   │
                 └─────┬──────┘
                       ▼
                 ┌────────────┐
                 │ classify   │
                 └─────┬──────┘
       md-only        │            code-containing
       ┌──────────────┴───────────────┐
       ▼                              ▼
 ┌────────────┐                 ┌────────────┐
 │ push-to-   │                 │ push-to-   │
 │ forgejo    │                 │ forgejo    │
 └─────┬──────┘                 └─────┬──────┘
       ▼                              ▼
 ┌────────────┐                 ┌────────────────┐
 │ screen-md  │                 │ questionnaire  │  (HITL, 7d)
 │ (LLM, opt) │                 └─────┬──────────┘
 └─────┬──────┘                       ▼
   clean│ flagged/error         ┌────────────────┐
       │   └──► review          │ scan (container)│
       ▼                        └─────┬──────────┘
 ┌────────────┐    block      pass/review_required
 │ auto-      │ ┌───────────┐        │
 │ approve    │ │ rejected  │◄───────┤
 └─────┬──────┘ └───────────┘        │
       │                             ▼
       │                       ┌────────────────┐
       │                       │ screen (LLM,opt)│  advisory; always falls through
       │                       └─────┬──────────┘
       │                             ▼
       │                       ┌────────────────┐
       │                       │ confirmation   │  (HITL, 14d)
       │                       └─────┬──────────┘
       │                              ▼
       │                        ┌────────────────┐
       │                        │ review         │  (HITL, 30d, Compliance)
       │                        └─────┬──────────┘
       │                              ▼
       └──────────────┬───────────────┘
                      ▼
                ┌─────────────┐
                │ publish     │   merge PR + Forgejo package + registry.json
                └─────┬───────┘
                      ▼
                ┌─────────────┐
                │ published   │
                └─────────────┘
```

## Blueprint Sketch

```typescript
import { Blueprint, HitlNode, ComputeNode } from 'flowcraft';
import type { Submission, ScanReport } from '@asr/core/types';
import { ForgejoClient } from '@asr/core/forgejo';
import { runScanner } from '../scan/runner.js';
import { runScreening } from '../screen/runScreening.js';   // optional LLM content screen

export const approvalPipeline = new Blueprint<Submission>('skill-approval')
  .node(new ComputeNode('classify', {
    idempotent: true,
    async execute(ctx) {
      const files = ctx.get<string[]>('files');
      const cls = classify(files);                  // whitelist
      ctx.set('classification', cls);
    },
  }))

  .node(new ComputeNode('push-to-forgejo', {
    idempotent: true,
    async execute(ctx) {
      const forgejo = ctx.svc(ForgejoClient);
      const { branch, prNumber } = await forgejo.openSubmissionPR({
        submissionId: ctx.get('submissionId'),
        manifest: ctx.get('manifest'),
        files: ctx.get('files'),
        autoApprove: ctx.get('classification') === 'md-only',
      });
      ctx.set('branchName', branch);
      ctx.set('prNumber', prNumber);
    },
  }))

  .node(new HitlNode('questionnaire', {
    prompt: () => ({ type: 'questionnaire', questions: generateSecurityQuestions() }),
    validate: (responses) => responses.every(r => r.answer !== undefined),
    timeout: '7d',
  }))

  .node(new ComputeNode('scan', {
    idempotent: true,
    async execute(ctx) {
      const report: ScanReport = await runScanner({
        submissionId: ctx.get('submissionId'),
        workdir: ctx.get('workdir'),
        contentHash: ctx.get('contentHash'),
      });
      ctx.set('scanReport', report);
      if (report.verdict === 'block') ctx.jump('rejected');
    },
  }))

  // Optional LLM screen — runs only when LLM_SCREEN_PROVIDER is configured.
  // Advisory on the code path: attaches a report, never alters the flow.
  .node(new ComputeNode('screen', {
    idempotent: true,
    async execute(ctx) {
      const report = await runScreening({               // injected; no-op → status 'skipped'
        submissionId: ctx.get('submissionId'),
        contentHash: ctx.get('contentHash'),
        extractedDir: ctx.get('workdir'),
        manifest: ctx.get('manifest'),
        questionnaire: ctx.get('questionnaireResponses'),
        classification: 'code-containing',
      });
      ctx.set('screeningReport', report);               // surfaced in compliance review
    },
  }))

  // Same core on the md-only path, but here it GATES: a finding (or error /
  // truncation) diverts to compliance review instead of silent auto-publish.
  .node(new ComputeNode('screen-md', {
    idempotent: true,
    async execute(ctx) {
      const report = await runScreening({
        submissionId: ctx.get('submissionId'),
        contentHash: ctx.get('contentHash'),
        extractedDir: ctx.get('workdir'),
        manifest: ctx.get('manifest'),
        classification: 'md-only',
      });
      ctx.set('screeningReport', report);
      if (report.status !== 'clean' && report.status !== 'skipped') ctx.jump('review');
    },
  }))

  .node(new HitlNode('confirmation', {
    prompt: (ctx) => ({ type: 'scan-results', report: ctx.get('scanReport') }),
    allowedActors: (ctx) => [ctx.get<Submission>('submission').submittedBy],
    timeout: '14d',
  }))

  .node(new HitlNode('review', {
    prompt: (ctx) => ({
      type: 'compliance-approval',
      submission: ctx.get('submission'),
      questionnaire: ctx.get('questionnaireResponses'),
      scanReport: ctx.get('scanReport'),
      versionDiff: ctx.get('versionDiff'),
    }),
    requiredRole: 'Compliance',
    forbiddenActors: (ctx) => [ctx.get<Submission>('submission').submittedBy], // separation of duties
    timeout: '30d',
  }))

  .node(new ComputeNode('auto-approve', {
    idempotent: true,
    async execute(ctx) {
      await ctx.audit('workflow.review.approved', { actor: 'system', auto: true });
    },
  }))

  .node(new ComputeNode('publish', {
    idempotent: true,
    async execute(ctx) {
      const forgejo = ctx.svc(ForgejoClient);
      const merge = await forgejo.mergePR(ctx.get('prNumber'));
      await forgejo.publishArtifact({
        owner: ctx.get('manifest').author,
        name: ctx.get('manifest').name,
        version: ctx.get('manifest').version,
        zipBuffer: ctx.get('zipBuffer'),
      });
      await regenerateRegistryIndex();
      await forgejo.deleteBranch(ctx.get('branchName'));
      ctx.set('mergeCommit', merge.sha);
    },
  }))

  .node(new ComputeNode('rejected', { /* writes status + emits audit */ }))

  // Edges (code path)
  .edge('classify', 'push-to-forgejo')
  .edge('push-to-forgejo', 'questionnaire', { when: (ctx) => ctx.get('classification') === 'code-containing' })
  .edge('questionnaire', 'scan')
  .edge('scan', 'screen', { when: (ctx) => ctx.get('scanReport').verdict !== 'block' })
  .edge('screen', 'confirmation')
  .edge('confirmation', 'review')
  .edge('review', 'publish')

  // Edges (auto-approve path — also goes through Forgejo, now via the md-only screen gate)
  .edge('push-to-forgejo', 'screen-md', { when: (ctx) => ctx.get('classification') === 'md-only' })
  .edge('screen-md', 'auto-approve', { when: (ctx) => ['clean', 'skipped'].includes(ctx.get('screeningReport').status) })
  .edge('auto-approve', 'publish');
  // screen-md jumps to 'review' in-node when status is flagged/error/truncated.
```

`ctx.svc` resolves a service from the DI container; `ctx.audit` is the single audit helper from [audit.md](audit.md) (validates against the closed action enum and writes atomically with the workflow state update).

## LLM Screening (optional node)

The `screen` / `screen-md` nodes wrap one provider-pluggable `runScreening()` core (see [security-scanning.md#llm-content-screening](security-scanning.md#llm-content-screening)). Activation is by env: when `LLM_SCREEN_PROVIDER` is unset, `runScreening` returns `status: 'skipped'` and both nodes pass straight through — the pipeline behaves exactly as it did before the feature existed. The dependency is injected (like `runScanner`) so tests stub it with a fake provider.

| Condition | Code path (`screen`) | Md-only path (`screen-md`) |
|-----------|----------------------|----------------------------|
| Unconfigured | `skipped` → confirmation | `skipped` → auto-approve (today's behavior) |
| `clean` | → confirmation | → auto-approve |
| `flagged` | advisory only → confirmation (already human-bound) | **gate** → review |
| `error` / timeout | advisory "screen unavailable" → confirmation | **fail closed** → review |
| `truncated` (over token budget) | `truncated` finding attached → confirmation | treated as a finding → review |

Each terminal emits `workflow.screening.completed` via `ctx.audit` (see [audit.md](audit.md)).

## State Persistence

`@flowcraft/history-sqlite` — same `workflow.db` file as the rest of the service, WAL mode, single writer.

## Crash Recovery (Resume)

On service startup, `resumeWorkflows()` scans `submissions` for any row whose status is non-terminal and re-enters the Flowcraft engine. Compute nodes are idempotent by contract:

- Each compute node carries an idempotency key derived from `(submissionId, nodeName, attempt)` that is passed to every external mutation (Forgejo branch creation, scan container run, merge).
- The Forgejo client treats `409 Conflict` from branch/PR creation as "already done" and reads the existing branch/PR instead.
- The scanner runner records `scan_results` keyed by `(submissionId, contentHash)`; a duplicate call returns the existing row.
- The publish step's `mergePR` is naturally idempotent (a re-attempt after merge returns the existing merge commit).

## Per-Skill Mutex

A submission for `skill_name=X version=Y` cannot proceed concurrently with another submission for the same pair. Enforced by an insert into:

```sql
CREATE TABLE pending_versions (
  skill_name      TEXT NOT NULL,
  version         TEXT NOT NULL,
  submission_id   TEXT NOT NULL REFERENCES submissions(id),
  acquired_at     TEXT NOT NULL,
  PRIMARY KEY (skill_name, version)
);
```

The submission API performs the insert inside the same transaction as the `submissions` row. A second submission for the same pair gets a unique-constraint violation → `409 version_in_progress`.

For two submissions of **different versions** of the same skill, both may run, but the workflow takes a per-skill advisory lock just before `publish` so merges to `main` serialise:

```sql
INSERT OR IGNORE INTO publish_locks(skill_name) VALUES (?);
-- if 0 rows changed, wait + retry with backoff up to 60s, then transition to error
```

After successful publish, the lock row is deleted.

## Timeout and Expiry

| Stage | Timeout | On Expiry |
|-------|---------|-----------|
| Questionnaire | 7 days | Notify submitter, extend 7d, then auto-reject |
| User confirmation | 14 days | Auto-reject |
| Compliance review | 30 days | Escalate to admin, extend 7d, then auto-reject |

Expirations emit the corresponding `workflow.review.rejected` (or auto-reject) audit event with `detail.reason='timeout'`.

## Separation of Duties

Enforced at both the HITL node level (`forbiddenActors`) and again at the API endpoint level (the approve/reject handler compares the caller's `sub` to `submission.submittedBy`). A user who loses the `Compliance` role between picking up a review and submitting a decision sees the decision rejected at submit time.
