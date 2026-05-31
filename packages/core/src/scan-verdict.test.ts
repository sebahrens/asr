import { describe, expect, it } from 'vitest';
import { computeVerdict } from './scan-verdict.js';
import type { ScanFinding, ScanReport } from './types.js';

describe('computeVerdict', () => {
  it('blocks when a non-skipped scanner exits non-zero with no findings', () => {
    expect(
      computeVerdict([], 'high', toolResults({ gitleaks: { exitCode: 2, findingCount: 0 } })),
    ).toBe('block');
  });

  it('allows gitleaks exit 1 when it corresponds to secret findings', () => {
    const findings: ScanFinding[] = [
      {
        tool: 'gitleaks',
        ruleId: 'generic-api-key',
        severity: 'high',
        file: 'SKILL.md',
        line: 12,
        message: 'Potential secret detected',
      },
    ];

    expect(
      computeVerdict(
        findings,
        'high',
        toolResults({ gitleaks: { exitCode: 1, findingCount: 1 } }),
      ),
    ).toBe('block');
  });

  it('blocks raw foxguard exit 2 with no findings', () => {
    expect(
      computeVerdict([], 'high', toolResults({ foxguard: { exitCode: 2, findingCount: 0 } })),
    ).toBe('block');
  });

  it('allows normalized foxguard findings when valid SARIF was proven by the wrapper', () => {
    const findings: ScanFinding[] = [
      {
        tool: 'foxguard',
        ruleId: 'js/command-injection',
        severity: 'high',
        file: 'scripts/deploy.ts',
        line: 42,
        message: 'User input reaches child_process.exec',
      },
    ];

    expect(
      computeVerdict(
        findings,
        'high',
        toolResults({ foxguard: { exitCode: 0, findingCount: 1 } }),
      ),
    ).toBe('review_required');
  });

  it('blocks raw foxguard exit 2 even when findings were parsed', () => {
    const findings: ScanFinding[] = [
      {
        tool: 'foxguard',
        ruleId: 'js/command-injection',
        severity: 'medium',
        file: 'scripts/deploy.ts',
        line: 42,
        message: 'User input reaches child_process.exec',
      },
    ];

    expect(
      computeVerdict(
        findings,
        'high',
        toolResults({ foxguard: { exitCode: 2, findingCount: 1 } }),
      ),
    ).toBe('block');
  });

  it('does not block optional skipped scanners with non-zero exits', () => {
    expect(
      computeVerdict(
        [],
        'high',
        toolResults({ veracode: { exitCode: 127, findingCount: 0, skipped: true } }),
      ),
    ).toBe('pass');
  });

  it('blocks when toolResults findingCount disagrees with findings', () => {
    expect(
      computeVerdict([], 'high', toolResults({ trivy: { exitCode: 0, findingCount: 1 } })),
    ).toBe('block');
  });

  it('keeps existing severity-based review behavior when toolResults are consistent', () => {
    const findings: ScanFinding[] = [
      {
        tool: 'trivy',
        ruleId: 'CVE-2026-0001',
        severity: 'high',
        file: 'package.json',
        line: 1,
        message: 'Vulnerable dependency',
      },
    ];

    expect(
      computeVerdict(findings, 'high', toolResults({ trivy: { exitCode: 0, findingCount: 1 } })),
    ).toBe('review_required');
  });
});

function toolResults(
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
