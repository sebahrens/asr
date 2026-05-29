import type { ScanFinding, ScanReport, ScanSeverity, ScanTool, ScanVerdict } from './types.js';

const severityRank: Record<ScanSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const scanTools: ScanTool[] = ['gitleaks', 'trivy', 'foxguard', 'opengrep', 'veracode'];

export function computeVerdict(
  findings: ScanFinding[],
  severityThreshold: ScanSeverity = 'high',
  toolResults?: ScanReport['toolResults'],
): ScanVerdict {
  if (hasFailedToolResult(findings, toolResults)) {
    return 'block';
  }

  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'block';
  }

  if (findings.some((finding) => finding.tool === 'gitleaks')) {
    return 'block';
  }

  const thresholdRank = severityRank[severityThreshold];
  if (findings.some((finding) => severityRank[finding.severity] >= thresholdRank)) {
    return 'review_required';
  }

  return 'pass';
}

function hasFailedToolResult(
  findings: ScanFinding[],
  toolResults: ScanReport['toolResults'] | undefined,
): boolean {
  if (!toolResults) {
    return false;
  }

  const findingCounts = new Map<ScanTool, number>();
  for (const finding of findings) {
    findingCounts.set(finding.tool, (findingCounts.get(finding.tool) ?? 0) + 1);
  }

  return scanTools.some((tool) => {
    const result = toolResults[tool];
    if (!result) {
      return true;
    }

    if (result.findingCount !== (findingCounts.get(tool) ?? 0)) {
      return true;
    }

    return result.exitCode !== 0 && result.skipped !== true;
  });
}
