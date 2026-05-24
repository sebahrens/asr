import { describe, expect, it } from 'vitest';
import type { ScanReport, ScanVerdict, SkillManifest, Submission, SubmissionStatus } from './types.js';

describe('scanning types', () => {
  it('accepts canonical scan reports', () => {
    const verdict: ScanVerdict = 'review_required';
    const report: ScanReport = {
      submissionId: 'sub_01',
      scanId: 'scan_01',
      contentHash: 'sha256:abc123',
      scannerImage: 'asr-scanner:1.4.0',
      startedAt: '2026-05-24T10:00:00.000Z',
      completedAt: '2026-05-24T10:00:01.250Z',
      durationMs: 1250,
      verdict,
      findings: [
        {
          tool: 'gitleaks',
          ruleId: 'generic-api-key',
          severity: 'high',
          file: 'SKILL.md',
          line: 12,
          message: 'Potential secret detected',
        },
      ],
      toolResults: {
        gitleaks: { exitCode: 1, findingCount: 1 },
        trivy: { exitCode: 0, findingCount: 0 },
        foxguard: { exitCode: 0, findingCount: 0 },
        opengrep: { exitCode: 0, findingCount: 0 },
        veracode: { exitCode: 0, findingCount: 0, skipped: true },
      },
    };

    expect(report.verdict).toBe('review_required');
    expect(report.findings).toHaveLength(1);
  });
});

describe('skill manifest types', () => {
  it('accepts canonical skill manifests', () => {
    const manifest: SkillManifest = {
      name: 'security-reviewer',
      version: '1.0.0',
      author: 'ASR Team',
      description: 'Reviews submissions for security risks.',
      tags: ['security', 'review'],
      kind: 'persona',
      persona_mode: 'delegate',
      references: ['base-reviewer'],
      entrypoint: 'SKILL.md',
      dependencies: {
        semver: '^7.7.3',
      },
      permissions: {
        network: true,
        networkHosts: ['forgejo.local'],
        filesystem: 'read-own',
        subprocess: false,
        environment: ['ASR_TOKEN'],
      },
      compatibility: {
        'claude-code': '>=1.0.0',
        codex: '>=1.0.0',
      },
    };

    expect(manifest.kind).toBe('persona');
    expect(manifest.permissions.filesystem).toBe('read-own');
  });
});

describe('submission types', () => {
  it('accepts scan-complete submissions and exhaustively narrows statuses', () => {
    const manifest: SkillManifest = {
      name: 'security-reviewer',
      version: '1.0.0',
      author: 'ASR Team',
      description: 'Reviews submissions for security risks.',
      tags: ['security', 'review'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    };

    const report: ScanReport = {
      submissionId: 'sub_01',
      scanId: 'scan_01',
      contentHash: 'sha256:abc123',
      scannerImage: 'asr-scanner:1.4.0',
      startedAt: '2026-05-24T10:00:00.000Z',
      completedAt: '2026-05-24T10:00:01.250Z',
      durationMs: 1250,
      verdict: 'pass',
      findings: [],
      toolResults: {
        gitleaks: { exitCode: 0, findingCount: 0 },
        trivy: { exitCode: 0, findingCount: 0 },
        foxguard: { exitCode: 0, findingCount: 0 },
        opengrep: { exitCode: 0, findingCount: 0 },
        veracode: { exitCode: 0, findingCount: 0, skipped: true },
      },
    };

    const submission: Submission = {
      id: 'sub_01',
      manifest,
      classification: 'md-only',
      contentHash: 'sha256:abc123',
      submittedAt: '2026-05-24T09:59:00.000Z',
      submittedBy: 'user_01',
      branchName: 'submissions/sub_01',
      prNumber: 42,
      status: { phase: 'scan-complete', report },
    };

    const describeStatus = (status: SubmissionStatus): string => {
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
          const exhaustive: never = status;
          return exhaustive;
        }
      }
    };

    expect(describeStatus(submission.status)).toBe('pass');
  });
});
