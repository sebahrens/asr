import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScanReport } from '@asr/core';
import { runScanner, type RunContainer } from './runScanner.js';

const input = {
  submissionId: 'sub_01',
  contentHash: 'sha256:abc123',
  extractedDir: '/tmp/extracted-skill',
};

describe('runScanner', () => {
  it('returns a signed block ScanReport from the scanner container', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');
    vi.stubEnv('SCANNER_SEVERITY_THRESHOLD', 'high');
    vi.stubEnv('SCANNER_TIMEOUT_SECONDS', '300');

    const report = signedReport(buildReport(), 'test-signing-key');
    const runContainer = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(report) }));

    await expect(runScanner(input, runContainer)).resolves.toMatchObject({
      submissionId: 'sub_01',
      contentHash: 'sha256:abc123',
      verdict: 'block',
      findings: [
        expect.objectContaining({
          tool: 'gitleaks',
          severity: 'high',
        }),
      ],
    });

    expect(runContainer).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '-v',
        '/tmp/extracted-skill:/scan/input:ro',
        '-v',
        expect.stringMatching(/\/asr-scan-sub_01-/),
        'asr-scanner:test',
      ]),
      expect.objectContaining({
        timeout: 360_000,
        env: expect.objectContaining({
          SUBMISSION_ID: 'sub_01',
          CONTENT_HASH: 'sha256:abc123',
          SCANNER_IMAGE: 'asr-scanner:test',
          SCAN_SEVERITY_THRESHOLD: 'high',
          SCAN_TIMEOUT_SECONDS: '300',
          SCAN_SIGNING_KEY: 'test-signing-key',
        }),
      }),
    );
  });

  it('rejects a report with a signature over different bytes', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');

    const tampered = signedReport(buildReport({ verdict: 'pass' }), 'test-signing-key');
    tampered.verdict = 'block';
    const runContainer = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(tampered) }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(/signature is invalid/);
  });
});

function buildReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    submissionId: 'sub_01',
    scanId: 'scan_01',
    contentHash: 'sha256:abc123',
    scannerImage: 'asr-scanner:test',
    startedAt: '2026-05-24T10:00:00.000Z',
    completedAt: '2026-05-24T10:00:01.250Z',
    durationMs: 1250,
    verdict: 'block',
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
    ...overrides,
  };
}

function signedReport(report: ScanReport, signingKey: string): ScanReport {
  return {
    ...report,
    signature: createHmac('sha256', signingKey).update(canonicalJson(report)).digest('hex'),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
