import { describe, expect, it } from 'vitest';
import type { ScanReport, ScanVerdict } from './types.js';

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
