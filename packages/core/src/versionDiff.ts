import type { RiskAssessment, VersionDiff } from './types.js';

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

export function assessRisk(diff: VersionDiff): RiskAssessment {
  if (Object.keys(diff.dependenciesAdded).length > 0) return 'high';
  if (Object.keys(diff.dependenciesChanged).length > 0) return 'high';
  if (diff.permissionsExpanded) return 'high';
  if (diff.manifestKindChanged) return 'high';
  if (diff.filesAdded.some((p) => !isMarkdownPath(p))) return 'high';

  if (diff.filesModified.some((p) => !isMarkdownPath(p))) return 'medium';

  return 'low';
}
