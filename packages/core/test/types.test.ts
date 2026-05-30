import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/index.js';
import type {
  AuditEvent,
  MarketplaceManifest,
  Questionnaire,
  RegistryIndex,
  ScreeningFinding,
  ScreeningReport,
  ScanFinding,
  ScanReport,
  SkillDetail,
  SkillManifest,
  Submission,
  SubmissionStatus,
  VersionDiff,
} from '../src/index.js';

const manifest: SkillManifest = {
  name: 'security-reviewer',
  version: '1.0.0',
  author: 'ASR Team',
  description: 'Reviews submitted skills for security risks.',
  tags: ['security'],
  kind: 'skill',
  permissions: {
    network: false,
    filesystem: 'read-own',
    subprocess: false,
    environment: [],
  },
  compatibility: {
    codex: '>=1.0.0',
  },
};

const finding: ScanFinding = {
  tool: 'gitleaks',
  ruleId: 'generic-api-key',
  severity: 'high',
  file: 'SKILL.md',
  line: 12,
  message: 'Potential secret detected',
};

const report: ScanReport = {
  submissionId: 'sub_01',
  scanId: 'scan_01',
  contentHash: 'sha256:abc123',
  scannerImage: 'asr-scanner:1.0.0',
  startedAt: '2026-05-24T10:00:00.000Z',
  completedAt: '2026-05-24T10:00:01.000Z',
  durationMs: 1000,
  verdict: 'review_required',
  findings: [finding],
  toolResults: {
    gitleaks: { exitCode: 1, findingCount: 1 },
    trivy: { exitCode: 0, findingCount: 0 },
    foxguard: { exitCode: 0, findingCount: 0 },
    opengrep: { exitCode: 0, findingCount: 0 },
    veracode: { exitCode: 0, findingCount: 0, skipped: true },
  },
};

const screeningFinding: ScreeningFinding = {
  category: 'questionnaire',
  severity: 'medium',
  file: 'SKILL.md',
  line: 24,
  declared: 'Does not call external services',
  observed: 'Documents an external API call',
  message: 'Questionnaire answer does not match the skill description.',
};

const screeningReport: ScreeningReport = {
  submissionId: 'sub_01',
  contentHash: report.contentHash,
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  contextTokens: 200000,
  status: 'flagged',
  truncated: false,
  startedAt: '2026-05-24T10:01:00.000Z',
  completedAt: '2026-05-24T10:01:02.000Z',
  durationMs: 2000,
  findings: [screeningFinding],
};

const questionnaire: Questionnaire = {
  id: 'questionnaire_01',
  submissionId: 'sub_01',
  questions: [
    {
      id: 'network-use',
      text: 'Does this skill contact external services?',
      type: 'boolean',
      required: true,
    },
  ],
  responses: [{ questionId: 'network-use', answer: false }],
  completedAt: '2026-05-24T10:02:00.000Z',
};

const statuses: SubmissionStatus[] = [
  { phase: 'uploaded' },
  { phase: 'classifying' },
  { phase: 'pushing-to-forgejo' },
  { phase: 'auto-approved', approvedAt: '2026-05-24T10:03:00.000Z' },
  { phase: 'questionnaire-pending', questionnaireId: questionnaire.id },
  { phase: 'scanning', scanJobId: 'scan_job_01' },
  { phase: 'scan-complete', report },
  { phase: 'user-confirmation-pending' },
  { phase: 'compliance-review', reviewerId: 'reviewer_01' },
  { phase: 'approved', approvedAt: '2026-05-24T10:04:00.000Z', approvedBy: 'reviewer_01' },
  { phase: 'published', publishedAt: '2026-05-24T10:05:00.000Z', mergeCommit: 'abc123' },
  { phase: 'rejected', rejectedAt: '2026-05-24T10:06:00.000Z', reason: 'Needs changes' },
  { phase: 'withdrawn', withdrawnAt: '2026-05-24T10:07:00.000Z' },
];

const submission: Submission = {
  id: 'sub_01',
  manifest,
  classification: 'md-only',
  contentHash: report.contentHash,
  submittedAt: '2026-05-24T09:59:00.000Z',
  submittedBy: 'user_01',
  branchName: 'submissions/sub_01',
  prNumber: 42,
  status: statuses[6]!,
};

const auditEvent: AuditEvent = {
  id: 'audit_01',
  submissionId: submission.id,
  skillName: manifest.name,
  version: manifest.version,
  timestamp: '2026-05-24T10:08:00.000Z',
  actor: 'system',
  actorType: 'system',
  action: AUDIT_ACTIONS[0],
  detail: { phase: submission.status.phase },
  prevHash: '0'.repeat(64),
  hash: '1'.repeat(64),
  hmacKeyId: 'key_01',
};

const versionDiff: VersionDiff = {
  skillName: manifest.name,
  fromVersion: '0.9.0',
  toVersion: manifest.version,
  fromContentHash: 'sha256:old',
  toContentHash: report.contentHash,
  filesAdded: [],
  filesRemoved: [],
  filesModified: ['SKILL.md'],
  dependenciesAdded: {},
  dependenciesRemoved: {},
  dependenciesChanged: {},
  permissionsBefore: manifest.permissions,
  permissionsAfter: manifest.permissions,
  permissionsExpanded: false,
  manifestKindChanged: false,
  riskAssessment: 'low',
  computedAt: '2026-05-24T10:09:00.000Z',
};

const registryIndex: RegistryIndex = {
  generatedAt: '2026-05-24T10:10:00.000Z',
  specVersion: '1',
  skills: [
    {
      owner: 'asr',
      name: manifest.name,
      latestVersion: manifest.version,
      description: manifest.description,
      tags: manifest.tags,
      kind: manifest.kind,
      publishedAt: '2026-05-24T10:11:00.000Z',
      downloadCount: 0,
      riskAssessmentLatest: versionDiff.riskAssessment,
    },
  ],
};

const skillDetail: SkillDetail = {
  ...registryIndex.skills[0]!,
  manifestLatest: manifest,
  skillMd: '# security-reviewer',
  versions: [
    {
      owner: 'asr',
      name: manifest.name,
      version: manifest.version,
      contentHash: report.contentHash,
      publishedAt: '2026-05-24T10:11:00.000Z',
      publishedBy: 'reviewer_01',
      approvedBy: 'reviewer_01',
      prNumber: 42,
      mergeCommit: 'abc123',
      yanked: false,
      riskAssessment: versionDiff.riskAssessment,
    },
  ],
};

const marketplaceManifest: MarketplaceManifest = {
  name: 'asr-marketplace',
  version: '1.0.0',
  plugins: [
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      path: 'skills/asr/security-reviewer',
      kind: manifest.kind,
    },
  ],
};

function describeStatus(status: SubmissionStatus): string {
  switch (status.phase) {
    case 'uploaded':
    case 'classifying':
    case 'pushing-to-forgejo':
    case 'user-confirmation-pending':
      return status.phase;
    case 'auto-approved':
      return status.approvedAt;
    case 'questionnaire-pending':
      return status.questionnaireId;
    case 'scanning':
      return status.scanJobId;
    case 'scan-complete':
      return status.report.verdict;
    case 'compliance-review':
      return status.reviewerId ?? 'unassigned';
    case 'approved':
      return status.approvedBy;
    case 'published':
      return status.mergeCommit;
    case 'rejected':
      return status.reason;
    case 'withdrawn':
      return status.withdrawnAt;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

describe('canonical public types', () => {
  it('type-checks consumer imports from @asr/core index exports', () => {
    expect(describeStatus(submission.status)).toBe('review_required');
    expect(statuses.map(describeStatus)).toHaveLength(13);
    expect(auditEvent.action).toBe('submission.created');
    expect(screeningReport.findings[0]?.category).toBe('questionnaire');
    expect(skillDetail.versions[0]?.contentHash).toBe(report.contentHash);
    expect(marketplaceManifest.plugins[0]?.path).toBe('skills/asr/security-reviewer');
  });
});
