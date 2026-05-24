import type { ScanFinding, ScanSeverity, ScanVerdict } from './types.js';

const severityRank: Record<ScanSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function computeVerdict(
  findings: ScanFinding[],
  severityThreshold: ScanSeverity = 'high',
): ScanVerdict {
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
