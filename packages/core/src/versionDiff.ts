import { isPermissionsExpanded } from './permissions.js';
import type { RiskAssessment, SkillManifest, VersionDiff } from './types.js';

export type ApprovalPath = 'auto-approve' | 'full-review' | 'rescan-conditional';

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

export function selectApprovalPath(diff: VersionDiff): ApprovalPath {
  if (diff.permissionsExpanded) return 'full-review';
  if (diff.manifestKindChanged) return 'full-review';
  if (Object.keys(diff.dependenciesAdded).length > 0) return 'full-review';
  if (diff.filesAdded.some((p) => !isMarkdownPath(p))) return 'full-review';
  if (diff.filesModified.some((p) => !isMarkdownPath(p))) return 'full-review';

  if (Object.keys(diff.dependenciesChanged).length > 0) return 'rescan-conditional';
  if (
    diff.permissionsBefore !== null &&
    !diff.permissionsExpanded &&
    isPermissionsExpanded(diff.permissionsAfter, diff.permissionsBefore)
  ) {
    return 'rescan-conditional';
  }

  return 'auto-approve';
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

export interface VersionSnapshot {
  version: string;
  contentHash: string;
  files: Record<string, string>;
  manifest: SkillManifest;
}

export function computeVersionDiff(
  from: VersionSnapshot | null,
  to: VersionSnapshot,
): VersionDiff {
  const fromFiles = from?.files ?? {};
  const toFiles = to.files;

  const filesAdded: string[] = [];
  const filesRemoved: string[] = [];
  const filesModified: string[] = [];

  for (const path of Object.keys(toFiles)) {
    if (!(path in fromFiles)) {
      filesAdded.push(path);
    } else if (fromFiles[path] !== toFiles[path]) {
      filesModified.push(path);
    }
  }
  for (const path of Object.keys(fromFiles)) {
    if (!(path in toFiles)) {
      filesRemoved.push(path);
    }
  }

  filesAdded.sort();
  filesRemoved.sort();
  filesModified.sort();

  const fromDeps = from?.manifest.dependencies ?? {};
  const toDeps = to.manifest.dependencies ?? {};

  const dependenciesAdded: Record<string, string> = {};
  const dependenciesRemoved: Record<string, string> = {};
  const dependenciesChanged: Record<string, { from: string; to: string }> = {};

  for (const [name, version] of Object.entries(toDeps)) {
    if (!(name in fromDeps)) {
      dependenciesAdded[name] = version;
    } else if (fromDeps[name] !== version) {
      dependenciesChanged[name] = { from: fromDeps[name], to: version };
    }
  }
  for (const [name, version] of Object.entries(fromDeps)) {
    if (!(name in toDeps)) {
      dependenciesRemoved[name] = version;
    }
  }

  const permissionsBefore = from?.manifest.permissions ?? null;
  const permissionsAfter = to.manifest.permissions;
  const permissionsExpanded = isPermissionsExpanded(permissionsBefore, permissionsAfter);

  const manifestKindChanged =
    from !== null &&
    (from.manifest.kind !== to.manifest.kind ||
      from.manifest.persona_mode !== to.manifest.persona_mode);

  const draft: VersionDiff = {
    skillName: to.manifest.name,
    fromVersion: from?.version ?? '',
    toVersion: to.version,
    fromContentHash: from?.contentHash ?? null,
    toContentHash: to.contentHash,
    filesAdded,
    filesRemoved,
    filesModified,
    dependenciesAdded,
    dependenciesRemoved,
    dependenciesChanged,
    permissionsBefore,
    permissionsAfter,
    permissionsExpanded,
    manifestKindChanged,
    riskAssessment: 'low',
    computedAt: new Date().toISOString(),
  };

  draft.riskAssessment = assessRisk(draft);
  return draft;
}
