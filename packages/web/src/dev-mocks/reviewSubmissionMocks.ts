import type { ScanReport, ScreeningReport, Submission, VersionDiff } from '@asr/core';

export interface ReviewSubmissionMockEvidence {
  submission: Submission;
  diff: VersionDiff;
  scan: ScanReport;
  screening: ScreeningReport;
}

const sub1042: ReviewSubmissionMockEvidence = {
  submission: {
    id: 'sub-1042',
    manifest: {
      name: 'secure-code-review',
      version: '1.4.0',
      author: 'platform',
      description: 'Review dependency changes before release and document compliance evidence.',
      tags: ['security', 'review'],
      kind: 'skill',
      permissions: {
        network: true,
        networkHosts: ['registry.npmjs.org', 'api.osv.dev'],
        filesystem: 'read-own',
        subprocess: true,
        environment: [],
      },
    },
    classification: 'code-containing',
    contentHash: 'sha256:dev-platform-secure-code-review-1.4.0',
    submittedAt: '2026-05-24T08:35:00.000Z',
    submittedBy: 'maria.chen',
    status: { phase: 'compliance-review' },
  },
  diff: {
    skillName: 'secure-code-review',
    fromVersion: '1.3.0',
    toVersion: '1.4.0',
    fromContentHash: 'sha256:dev-platform-secure-code-review-1.3.0',
    toContentHash: 'sha256:dev-platform-secure-code-review-1.4.0',
    filesAdded: ['scripts/check-deps.ts'],
    filesRemoved: [],
    filesModified: ['SKILL.md'],
    dependenciesAdded: { '@actions/core': '1.10.1' },
    dependenciesRemoved: {},
    dependenciesChanged: { semver: { from: '7.5.4', to: '7.6.3' } },
    permissionsBefore: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsAfter: {
      network: true,
      networkHosts: ['registry.npmjs.org', 'api.osv.dev'],
      filesystem: 'read-own',
      subprocess: true,
      environment: [],
    },
    permissionsExpanded: true,
    manifestKindChanged: false,
    riskAssessment: 'high',
    computedAt: '2026-05-24T08:38:00.000Z',
  },
  scan: {
    submissionId: 'sub-1042',
    scanId: 'scan-sub-1042',
    contentHash: 'sha256:dev-platform-secure-code-review-1.4.0',
    scannerImage: 'asr-scanner:dev',
    startedAt: '2026-05-24T08:36:00.000Z',
    completedAt: '2026-05-24T08:38:00.000Z',
    durationMs: 120000,
    verdict: 'review_required',
    findings: [
      {
        tool: 'opengrep',
        ruleId: 'subprocess-unpinned',
        severity: 'high',
        file: 'scripts/check-deps.ts',
        line: 16,
        message: 'Subprocess capability requires justification — verify command pinning and read-only execution.',
      },
      {
        tool: 'trivy',
        ruleId: 'dependency-upgrade-review',
        severity: 'medium',
        file: 'package.json',
        line: 1,
        message: 'Dependency upgrade requires review: semver changed from 7.5.4 to 7.6.3.',
      },
    ],
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: 0 },
      trivy: { exitCode: 0, findingCount: 1 },
      foxguard: { exitCode: 0, findingCount: 0 },
      opengrep: { exitCode: 0, findingCount: 1 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
  },
  screening: {
    submissionId: 'sub-1042',
    contentHash: 'sha256:dev-platform-secure-code-review-1.4.0',
    provider: 'openai',
    model: 'gpt-dev-screen',
    contextTokens: 8192,
    status: 'flagged',
    truncated: false,
    startedAt: '2026-05-24T08:37:00.000Z',
    completedAt: '2026-05-24T08:37:12.000Z',
    durationMs: 12000,
    findings: [
      {
        category: 'permission',
        severity: 'high',
        file: 'scripts/check-deps.ts',
        line: 16,
        declared: 'subprocess: true',
        observed: 'Runs package manager commands from scripts/check-deps.ts:16',
        message: 'Subprocess behavior needs reviewer confirmation.',
      },
    ],
  },
};

const sub1039: ReviewSubmissionMockEvidence = {
  submission: {
    id: 'sub-1039',
    manifest: {
      name: 'release-notes',
      version: '0.8.2',
      author: 'docs',
      description: 'Draft concise release notes from merged pull requests.',
      tags: ['docs', 'release'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    },
    classification: 'md-only',
    contentHash: 'sha256:dev-docs-release-notes-0.8.2',
    submittedAt: '2026-05-23T17:10:00.000Z',
    submittedBy: 'eli.warner',
    status: { phase: 'compliance-review' },
  },
  diff: {
    skillName: 'release-notes',
    fromVersion: '0.8.1',
    toVersion: '0.8.2',
    fromContentHash: 'sha256:dev-docs-release-notes-0.8.1',
    toContentHash: 'sha256:dev-docs-release-notes-0.8.2',
    filesAdded: ['templates/changelog.md'],
    filesRemoved: [],
    filesModified: ['SKILL.md'],
    dependenciesAdded: {},
    dependenciesRemoved: {},
    dependenciesChanged: { 'markdown-it': { from: '13.0.2', to: '14.1.0' } },
    permissionsBefore: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsAfter: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'medium',
    computedAt: '2026-05-23T17:12:00.000Z',
  },
  scan: {
    submissionId: 'sub-1039',
    scanId: 'scan-sub-1039',
    contentHash: 'sha256:dev-docs-release-notes-0.8.2',
    scannerImage: 'asr-scanner:dev',
    startedAt: '2026-05-23T17:11:00.000Z',
    completedAt: '2026-05-23T17:12:00.000Z',
    durationMs: 60000,
    verdict: 'review_required',
    findings: [
      {
        tool: 'foxguard',
        ruleId: 'filesystem-scope-expanded',
        severity: 'medium',
        file: 'manifest.yaml',
        line: 1,
        message: 'Filesystem read scope expanded to repository markdown and changelog files.',
      },
    ],
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: 0 },
      trivy: { exitCode: 0, findingCount: 0 },
      foxguard: { exitCode: 0, findingCount: 1 },
      opengrep: { exitCode: 0, findingCount: 0 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
  },
  screening: {
    submissionId: 'sub-1039',
    contentHash: 'sha256:dev-docs-release-notes-0.8.2',
    provider: 'none',
    model: 'none',
    contextTokens: 0,
    status: 'skipped',
    truncated: false,
    startedAt: '2026-05-23T17:11:30.000Z',
    completedAt: '2026-05-23T17:11:30.000Z',
    durationMs: 0,
    findings: [],
  },
};

const sub1031: ReviewSubmissionMockEvidence = {
  submission: {
    id: 'sub-1031',
    manifest: {
      name: 'test-plan-writer',
      version: '2.1.1',
      author: 'qa',
      description: 'Generate structured test plans from feature specifications.',
      tags: ['qa', 'testing'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    },
    classification: 'md-only',
    contentHash: 'sha256:dev-qa-test-plan-writer-2.1.1',
    submittedAt: '2026-05-23T11:42:00.000Z',
    submittedBy: 'nora.patel',
    status: { phase: 'user-confirmation-pending' },
  },
  diff: {
    skillName: 'test-plan-writer',
    fromVersion: '2.1.0',
    toVersion: '2.1.1',
    fromContentHash: 'sha256:dev-qa-test-plan-writer-2.1.0',
    toContentHash: 'sha256:dev-qa-test-plan-writer-2.1.1',
    filesAdded: [],
    filesRemoved: [],
    filesModified: ['SKILL.md'],
    dependenciesAdded: {},
    dependenciesRemoved: {},
    dependenciesChanged: {},
    permissionsBefore: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsAfter: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'low',
    computedAt: '2026-05-23T11:43:00.000Z',
  },
  scan: {
    submissionId: 'sub-1031',
    scanId: 'scan-sub-1031',
    contentHash: 'sha256:dev-qa-test-plan-writer-2.1.1',
    scannerImage: 'asr-scanner:dev',
    startedAt: '2026-05-23T11:42:30.000Z',
    completedAt: '2026-05-23T11:43:00.000Z',
    durationMs: 30000,
    verdict: 'pass',
    findings: [],
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: 0 },
      trivy: { exitCode: 0, findingCount: 0 },
      foxguard: { exitCode: 0, findingCount: 0 },
      opengrep: { exitCode: 0, findingCount: 0 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
  },
  screening: {
    submissionId: 'sub-1031',
    contentHash: 'sha256:dev-qa-test-plan-writer-2.1.1',
    provider: 'openai',
    model: 'gpt-dev-screen',
    contextTokens: 8192,
    status: 'clean',
    truncated: false,
    startedAt: '2026-05-23T11:42:35.000Z',
    completedAt: '2026-05-23T11:42:43.000Z',
    durationMs: 8000,
    findings: [],
  },
};

const mocks: Record<string, ReviewSubmissionMockEvidence> = {
  'sub-1042': sub1042,
  'sub-1039': sub1039,
  'sub-1031': sub1031,
};

export function isDevMockMode(): boolean {
  return (
    import.meta.env.MODE === 'development' &&
    !import.meta.env.VITE_API_URL
  );
}

export function getReviewSubmissionMock(id: string): ReviewSubmissionMockEvidence | undefined {
  return mocks[id];
}
