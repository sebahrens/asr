export interface SkillMeta {
  name: string;
  description: string;
  tags?: string[];
  author?: string;
  version?: string;
}

export interface Skill extends SkillMeta {
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

export interface CompatibilityManifest {
  'claude-code'?: string;
  codex?: string;
}

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
