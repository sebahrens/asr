# Type Definitions (canonical)

**Source of truth.** Every package consumes these via `@asr/core`. If a type below disagrees with anything in another spec, *this* file wins; the other spec must be updated.

## Skill Manifest

```typescript
// @asr/core/types

export type SkillKind = 'skill' | 'persona';
export type PersonaMode = 'inject' | 'delegate';

export interface PermissionsManifest {
  network: boolean;
  networkHosts?: string[];           // explicit allowlist; if present, network must be true
  filesystem: 'none' | 'read-own' | 'read-write-own';
  subprocess: boolean;
  environment: string[];             // env var names the skill reads
}

export interface CompatibilityManifest {
  'claude-code'?: string;            // semver range
  codex?: string;                    // semver range
}

export interface SkillManifest {
  name: string;
  version: string;                   // semver
  author: string;                    // free-form display, identity carried separately by `publishedBy`
  description: string;
  tags: string[];

  // kind/persona
  kind: SkillKind;                   // default 'skill' if omitted in YAML
  persona_mode?: PersonaMode;        // required iff kind === 'persona'; default 'inject'
  references?: string[];             // other skill names referenced by a delegate persona

  // entry + deps
  entrypoint?: string;               // defaults to SKILL.md
  dependencies?: Record<string, string>;

  // governance
  permissions: PermissionsManifest;
  compatibility?: CompatibilityManifest;
}
```

The Hono validation layer parses raw `manifest.yaml` through a zod schema and emits a typed `SkillManifest`. Unknown fields are rejected (strict mode).

## Submission

```typescript
export type SkillClassification = 'md-only' | 'code-containing';

export interface Submission {
  id: string;                        // ULID
  manifest: SkillManifest;
  classification: SkillClassification;
  contentHash: string;               // canonical SHA-256; see specs/versioning.md
  submittedAt: string;               // ISO 8601 UTC
  submittedBy: string;               // Entra `sub`
  branchName?: string;               // set after push-to-forgejo (even MD-only)
  prNumber?: number;                 // set after push-to-forgejo (even MD-only)
  status: SubmissionStatus;
}

export type SubmissionStatus =
  | { phase: 'uploaded' }
  | { phase: 'classifying' }
  | { phase: 'pushing-to-forgejo' }
  | { phase: 'auto-approved'; approvedAt: string }
  | { phase: 'questionnaire-pending'; questionnaireId: string }
  | { phase: 'scanning'; scanJobId: string }
  | { phase: 'scan-complete'; report: ScanReport }
  | { phase: 'user-confirmation-pending' }
  | { phase: 'compliance-review'; reviewerId?: string }
  | { phase: 'approved'; approvedAt: string; approvedBy: string }
  | { phase: 'published'; publishedAt: string; mergeCommit: string }
  | { phase: 'rejected'; rejectedAt: string; reason: string }
  | { phase: 'withdrawn'; withdrawnAt: string };
```

## Scanning

The scanner is an external Docker container. There is **no** in-process plugin model. See [security-scanning.md](security-scanning.md) for the orchestration; the types below are the canonical shape of what comes back from `runScanner()`.

```typescript
export type ScanSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ScanTool = 'gitleaks' | 'trivy' | 'foxguard' | 'opengrep' | 'veracode';
export type ScanVerdict = 'pass' | 'review_required' | 'block';

export interface ScanFinding {
  tool: ScanTool;
  ruleId: string;
  severity: ScanSeverity;
  file: string;
  line: number;
  message: string;
  snippet?: string;
}

export interface ScanReport {
  submissionId: string;
  scanId: string;                    // ULID
  contentHash: string;               // mirror of Submission.contentHash for join-ability
  scannerImage: string;              // e.g. "asr-scanner:1.4.0"
  startedAt: string;
  completedAt: string;
  durationMs: number;
  verdict: ScanVerdict;
  findings: ScanFinding[];
  toolResults: Record<ScanTool, { exitCode: number; findingCount: number; skipped?: true }>;
  signature?: string;                // optional detached signature over the report JSON
}
```

`verdict` is the single field consumers branch on. The verdict computation lives in `@asr/core/scan-verdict` and is pure:

```typescript
export function computeVerdict(
  findings: ScanFinding[],
  severityThreshold: ScanSeverity = 'high',
  toolResults?: ScanReport['toolResults'],
): ScanVerdict;
```

## LLM Content Screening

An **optional, provider-pluggable** LLM reads the full extracted skill content and checks that the submitter's declared statements (the `PermissionsManifest` and the questionnaire answers) match what the code actually does, plus screens for description accuracy and malicious intent. It is a *separate* analyzer from the Docker scanner — it never feeds `ScanReport.verdict`. It is **advisory** for code-containing skills and a **fail-closed gate** for md-only skills. See [security-scanning.md#llm-content-screening](security-scanning.md#llm-content-screening) for orchestration and [workflow.md](workflow.md) for pipeline placement.

```typescript
export type ScreeningProviderKind = 'openai' | 'anthropic';
export type ScreeningCategory = 'permission' | 'questionnaire' | 'description' | 'malicious';
export type ScreeningStatus = 'clean' | 'flagged' | 'skipped' | 'error';

export interface ScreeningFinding {
  category: ScreeningCategory;
  severity: ScanSeverity;            // reuses the scanner severity scale
  file?: string;                     // path inside the skill, when locatable
  line?: number;
  declared?: string;                 // what the submitter stated, e.g. "network: false"
  observed?: string;                 // what the content shows, e.g. "fetch('https://…') at scripts/run.sh:12"
  message: string;
}

export interface ScreeningReport {
  submissionId: string;
  contentHash: string;               // mirror of Submission.contentHash for join-ability
  provider: ScreeningProviderKind;
  model: string;                     // resolved model id used
  contextTokens: number;             // declared context window the budget was derived from
  status: ScreeningStatus;
  truncated: boolean;                // content exceeded the token budget; partial screen
  startedAt: string;
  completedAt: string;
  durationMs: number;
  findings: ScreeningFinding[];
}
```

`status` drives the pipeline edge: `flagged`/`error`/`truncated` divert an **md-only** submission to compliance `review`; for **code-containing** submissions the report is attached for the reviewer but the flow is unchanged. When screening is unconfigured the report is `status: 'skipped'` with no findings. The screen is carried on the workflow context (`screeningReport`) and persisted alongside the scan report; it is included in the compliance-review payload (see [web-ui.md](web-ui.md) Screening tab).

## Questionnaire

Questionnaire responses are currently modeled as free-form HITL payloads on the workflow context. The API persists the workflow signal and exposes a `questionnaire-pending` status with a deterministic `questionnaire:<submissionId>` id; there is no generated question-set contract, no questionnaire template endpoint, and no persisted `questionnaireSetVersion` field on `Submission`.

```typescript
export interface QuestionnaireQuestion {
  id: string;
  text: string;
  type: 'boolean' | 'text' | 'select';
  options?: string[];
  required: boolean;
}

export interface QuestionnaireResponse {
  questionId: string;
  answer: string | boolean;
}

export interface Questionnaire {
  id: string;
  submissionId: string;
  questions: QuestionnaireQuestion[];
  responses?: QuestionnaireResponse[];
  completedAt?: string;
}
```

These `Questionnaire*` types live in `@asr/core/types` for clients that need to display or serialize questionnaire-shaped data, but they do not imply a built-in generator or versioned static question set.

## Audit

```typescript
import { AUDIT_ACTIONS, AuditAction } from './audit.js';

export interface AuditEvent {
  id: string;                        // ULID
  submissionId: string | null;
  skillName: string | null;
  version: string | null;
  timestamp: string;                 // ISO 8601 UTC
  actor: string;                     // Entra `sub` or 'system'
  actorType: 'user' | 'system' | 'compliance';
  action: AuditAction;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
  hmacKeyId: string;
}
```

See [audit.md](audit.md) for the full action enum.

## Version Diff

See [versioning.md#versiondiff-canonical-type](versioning.md#versiondiff-canonical-type) for `VersionDiff`. Re-exported from `@asr/core/types`.

## Skill (published artifact, distinct from Submission)

```typescript
export interface SkillVersion {
  owner: string;
  name: string;
  version: string;
  contentHash: string;
  publishedAt: string;
  publishedBy: string;
  approvedBy: string | null;         // null for auto-approved
  prNumber: number;
  mergeCommit: string;
  yanked: boolean;
  yankedAt?: string;
  yankReason?: string;
  riskAssessment: 'low' | 'medium' | 'high';
}

export interface SkillSummary {
  owner: string;
  name: string;
  latestVersion: string;
  description: string;
  tags: string[];
  kind: SkillKind;
  publishedAt: string;
  downloadCount: number;
  riskAssessmentLatest: 'low' | 'medium' | 'high';
}

export interface SkillDetail extends SkillSummary {
  manifestLatest: SkillManifest;
  skillMd?: string;
  versions: SkillVersion[];
}
```

## Registry index

```typescript
// Serialised to skills-registry/registry.json on every publish/yank
export interface RegistryIndex {
  generatedAt: string;
  specVersion: '1';
  skills: SkillSummary[];
}
```

## Marketplace manifest

```typescript
export interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  path: string;                      // relative to marketplace repo root
  kind: SkillKind;
}

export interface MarketplaceManifest {
  name: string;
  version: string;
  plugins: MarketplacePlugin[];
}
```
