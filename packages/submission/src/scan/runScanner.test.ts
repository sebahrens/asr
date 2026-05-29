import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanReport } from '@asr/core';
import { runScanner, type RunContainer } from './runScanner.js';

const input = {
  submissionId: 'sub_01',
  contentHash: 'sha256:abc123',
  extractedDir: '/tmp/extracted-skill',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

    const tampered = signedReport(buildReport(), 'test-signing-key');
    tampered.scannerImage = 'asr-scanner:tampered';
    const runContainer = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(tampered) }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(/signature is invalid/);
  });

  it('rejects an unsigned report when the signing key is set', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');

    const runContainer = vi.fn<RunContainer>(async () => ({
      stdout: JSON.stringify(
        buildReport({ verdict: 'pass', findings: [], toolResults: cleanToolResults() }),
      ),
    }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(/signature is missing/);
  });

  it('fails closed when the signing key is missing without an explicit dev opt-out', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', '');

    const runContainer = vi.fn<RunContainer>(async () => ({
      stdout: JSON.stringify(
        buildReport({ verdict: 'pass', findings: [], toolResults: cleanToolResults() }),
      ),
    }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(
      /SCAN_SIGNING_KEY is required to verify scanner reports/,
    );
    expect(runContainer).not.toHaveBeenCalled();
  });

  it('warns and skips verification only with an explicit non-production opt-out', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', '');
    vi.stubEnv('SCAN_SIGNING_DISABLED', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const runContainer = vi.fn<RunContainer>(async () => ({
      stdout: JSON.stringify(
        buildReport({ verdict: 'pass', findings: [], toolResults: cleanToolResults() }),
      ),
    }));

    await expect(runScanner(input, runContainer)).resolves.toMatchObject({
      verdict: 'pass',
    });
    expect(warn).toHaveBeenCalledWith(
      'WARNING: scanner report signature verification is disabled',
    );
  });

  it('veracode env pass-through', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');

    vi.stubEnv('VERACODE_API_KEY_ID', '');
    vi.stubEnv('VERACODE_API_KEY_SECRET', '');
    vi.stubEnv('VERACODE_POLICY', '');

    const report = signedReport(
      buildReport({ verdict: 'pass', findings: [], toolResults: cleanToolResults() }),
      'test-signing-key',
    );
    const unsetRun = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(report) }));

    const unsetResult = await runScanner(input, unsetRun);
    expect(unsetResult.verdict).toBeDefined();
    expect(unsetResult.toolResults.veracode?.skipped).toBe(true);

    const unsetArgs = unsetRun.mock.calls[0]?.[1] ?? [];
    expect(unsetArgs).not.toContain('VERACODE_API_KEY_ID');
    expect(unsetArgs).not.toContain('VERACODE_API_KEY_SECRET');
    expect(unsetArgs).not.toContain('VERACODE_POLICY');

    vi.stubEnv('VERACODE_API_KEY_ID', 'id-value');
    vi.stubEnv('VERACODE_API_KEY_SECRET', 'secret-value');
    vi.stubEnv('VERACODE_POLICY', 'Anthropic-Default');

    const setRun = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(report) }));
    await runScanner(input, setRun);

    const setArgs = setRun.mock.calls[0]?.[1] ?? [];
    expect(adjacentPairs(setArgs)).toEqual(
      expect.arrayContaining([
        ['--env', 'VERACODE_API_KEY_ID'],
        ['--env', 'VERACODE_API_KEY_SECRET'],
        ['--env', 'VERACODE_POLICY'],
      ]),
    );
  });

  it('rejects a pass report when a required scanner errored without findings', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');

    const report = signedReport(
      buildReport({
        verdict: 'pass',
        findings: [],
        toolResults: cleanToolResults({ gitleaks: { exitCode: 2, findingCount: 0 } }),
      }),
      'test-signing-key',
    );
    const runContainer = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(report) }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(
      /Scanner verdict mismatch: expected block, received pass/,
    );
  });

  it('rejects a report when toolResults findingCount disagrees with findings', async () => {
    vi.stubEnv('SCANNER_IMAGE', 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', 'test-signing-key');

    const report = signedReport(
      buildReport({
        verdict: 'pass',
        findings: [],
        toolResults: cleanToolResults({ trivy: { exitCode: 0, findingCount: 1 } }),
      }),
      'test-signing-key',
    );
    const runContainer = vi.fn<RunContainer>(async () => ({ stdout: JSON.stringify(report) }));

    await expect(runScanner(input, runContainer)).rejects.toThrow(
      /Scanner verdict mismatch: expected block, received pass/,
    );
  });
});

function adjacentPairs(args: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    pairs.push([args[i]!, args[i + 1]!]);
  }
  return pairs;
}

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

function cleanToolResults(
  overrides: Partial<ScanReport['toolResults']> = {},
): ScanReport['toolResults'] {
  return {
    gitleaks: { exitCode: 0, findingCount: 0 },
    trivy: { exitCode: 0, findingCount: 0 },
    foxguard: { exitCode: 0, findingCount: 0 },
    opengrep: { exitCode: 0, findingCount: 0 },
    veracode: { exitCode: 0, findingCount: 0, skipped: true },
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
