import type { AuditAction } from './audit.js';

export interface SkillMeta {
  name: string;
  description: string;
  tags?: string[];
  author?: string;
  version?: string;
}

export interface LegacySkillSearchResult extends SkillMeta {
  repo: string;
  path: string;
  content: string;
  stars?: number;
  installs?: number;
  updatedAt?: string;
}

export interface InstalledSkill {
  name: string;
  source: string;
  version?: string;
  commit?: string;
  installedAt: string;
  updatedAt: string;
  contentHash?: string;
  sourceUrl?: string;
}

export interface LockFile {
  version: 1;
  skills: Record<string, InstalledSkill>;
}

export interface SkillIndex {
  id: string;
  repo: string;
  name: string;
  description: string;
  tags: string[];
  stars: number;
  installs: number;
  updatedAt: string;
}

export interface RegistryConfig {
  url: string;
  token?: string;
}

export interface InstallOptions {
  target: 'cursor' | 'claude' | 'project';
  global?: boolean;
}

export type SkillKind = 'skill' | 'persona';
export type PersonaMode = 'inject' | 'delegate';

export interface PermissionsManifest {
  network: boolean;
  networkHosts?: string[];
  filesystem: 'none' | 'read-own' | 'read-write-own';
  subprocess: boolean;
  environment: string[];
}

export type SkillManifestPermissions = PermissionsManifest;

export interface CompatibilityManifest {
  'claude-code'?: string;
  codex?: string;
}

export type SkillManifestCompatibility = CompatibilityManifest;

export interface SkillManifest {
  name: string;
  version: string;
  author: string;
  description: string;
  tags: string[];

  kind: SkillKind;
  persona_mode?: PersonaMode;
  references?: string[];

  entrypoint?: string;
  dependencies?: Record<string, string>;

  permissions: PermissionsManifest;
  compatibility?: CompatibilityManifest;
}

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
  scanId: string;
  contentHash: string;
  scannerImage: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  verdict: ScanVerdict;
  findings: ScanFinding[];
  toolResults: Record<ScanTool, { exitCode: number; findingCount: number; skipped?: true }>;
  signature?: string;
}

export type SkillClassification = 'md-only' | 'code-containing';

export interface Submission {
  id: string;
  manifest: SkillManifest;
  classification: SkillClassification;
  contentHash: string;
  submittedAt: string;
  submittedBy: string;
  branchName?: string;
  prNumber?: number;
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

export type QuestionnaireSchema = Questionnaire;
export type QuestionnaireAnswer = QuestionnaireResponse;

export interface AuditEvent {
  id: string;
  submissionId: string | null;
  skillName: string | null;
  version: string | null;
  timestamp: string;
  actor: string;
  actorType: 'user' | 'system' | 'compliance';
  action: AuditAction;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
  hmacKeyId: string;
}

export type RiskAssessment = 'low' | 'medium' | 'high';

export interface VersionDiff {
  skillName: string;
  fromVersion: string;
  toVersion: string;
  fromContentHash: string | null;
  toContentHash: string;
  filesAdded: string[];
  filesRemoved: string[];
  filesModified: string[];
  dependenciesAdded: Record<string, string>;
  dependenciesRemoved: Record<string, string>;
  dependenciesChanged: Record<string, { from: string; to: string }>;
  permissionsBefore: PermissionsManifest | null;
  permissionsAfter: PermissionsManifest;
  permissionsExpanded: boolean;
  manifestKindChanged: boolean;
  riskAssessment: RiskAssessment;
  computedAt: string;
}

export interface SkillVersion {
  owner: string;
  name: string;
  version: string;
  contentHash: string;
  publishedAt: string;
  publishedBy: string;
  approvedBy: string | null;
  prNumber: number;
  mergeCommit: string;
  yanked: boolean;
  yankedAt?: string;
  yankReason?: string;
  riskAssessment: RiskAssessment;
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
  riskAssessmentLatest: RiskAssessment;
}

export interface SkillDetail extends SkillSummary {
  manifestLatest: SkillManifest;
  skillMd?: string;
  versions: SkillVersion[];
}

export type Skill = SkillDetail;

export interface RegistryIndex {
  generatedAt: string;
  specVersion: '1';
  skills: SkillSummary[];
}

export interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  path: string;
  kind: SkillKind;
}

export interface MarketplaceManifest {
  name: string;
  version: string;
  plugins: MarketplacePlugin[];
}
