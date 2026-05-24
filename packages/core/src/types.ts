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
