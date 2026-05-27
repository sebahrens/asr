import { describe, expect, it } from 'vitest';

import {
  assessRisk,
  computeVersionDiff,
  selectApprovalPath,
  type VersionSnapshot,
} from './versionDiff.js';
import type { PermissionsManifest, SkillManifest, VersionDiff } from './types.js';

function basePermissions(overrides: Partial<PermissionsManifest> = {}): PermissionsManifest {
  return {
    network: false,
    subprocess: false,
    filesystem: 'none',
    environment: [],
    ...overrides,
  };
}

function baseManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'demo',
    version: '1.0.0',
    author: 'alice',
    description: 'demo skill',
    tags: [],
    kind: 'skill',
    permissions: basePermissions(),
    ...overrides,
  };
}

function snapshot(overrides: Partial<VersionSnapshot> = {}): VersionSnapshot {
  return {
    version: '1.0.0',
    contentHash: 'sha256:aaa',
    files: { 'SKILL.md': 'blob:md-1' },
    manifest: baseManifest(),
    ...overrides,
  };
}

function baseDiff(overrides: Partial<VersionDiff> = {}): VersionDiff {
  return {
    skillName: 'demo',
    fromVersion: '1.0.0',
    toVersion: '1.0.1',
    fromContentHash: 'sha256:aaa',
    toContentHash: 'sha256:bbb',
    filesAdded: [],
    filesRemoved: [],
    filesModified: [],
    dependenciesAdded: {},
    dependenciesRemoved: {},
    dependenciesChanged: {},
    permissionsBefore: basePermissions(),
    permissionsAfter: basePermissions(),
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'low',
    computedAt: '2026-05-27T00:00:00Z',
    ...overrides,
  };
}

describe('assessRisk', () => {
  it('returns low for markdown-only modification with unchanged permissions', () => {
    expect(assessRisk(baseDiff({ filesModified: ['SKILL.md'] }))).toBe('low');
  });

  it('returns high when dependencies are added', () => {
    expect(assessRisk(baseDiff({ dependenciesAdded: { lodash: '^4' } }))).toBe('high');
  });

  it('returns high when permissions are expanded', () => {
    expect(assessRisk(baseDiff({ permissionsExpanded: true }))).toBe('high');
  });

  it('returns medium for code-only modification with no deps/perms changes', () => {
    expect(assessRisk(baseDiff({ filesModified: ['src/run.ts'] }))).toBe('medium');
  });

  it('returns high when dependencies are changed', () => {
    expect(
      assessRisk(baseDiff({ dependenciesChanged: { lodash: { from: '^4.0.0', to: '^4.17.0' } } })),
    ).toBe('high');
  });

  it('returns high when manifest kind changed', () => {
    expect(assessRisk(baseDiff({ manifestKindChanged: true }))).toBe('high');
  });

  it('returns high when a non-markdown file is added', () => {
    expect(assessRisk(baseDiff({ filesAdded: ['src/new.ts'] }))).toBe('high');
  });

  it('treats markdown additions (.md, .markdown) as not triggering high', () => {
    expect(assessRisk(baseDiff({ filesAdded: ['docs/NOTES.md', 'guide.markdown'] }))).toBe('low');
  });

  it('is case-insensitive on markdown extensions', () => {
    expect(assessRisk(baseDiff({ filesModified: ['README.MD'] }))).toBe('low');
    expect(assessRisk(baseDiff({ filesAdded: ['docs/CHANGES.Markdown'] }))).toBe('low');
  });

  it('classifies mixed markdown + code modification as medium', () => {
    expect(assessRisk(baseDiff({ filesModified: ['SKILL.md', 'src/run.ts'] }))).toBe('medium');
  });

  it('prefers high over medium when both code edits and deps changes exist', () => {
    expect(
      assessRisk(
        baseDiff({
          filesModified: ['src/run.ts'],
          dependenciesAdded: { axios: '^1' },
        }),
      ),
    ).toBe('high');
  });
});

describe('selectApprovalPath', () => {
  it('returns auto-approve for a markdown-only modification with no dep/permission changes', () => {
    expect(selectApprovalPath(baseDiff({ filesModified: ['SKILL.md'] }))).toBe('auto-approve');
  });

  it('returns auto-approve for markdown-only additions', () => {
    expect(selectApprovalPath(baseDiff({ filesAdded: ['docs/INTRO.md'] }))).toBe('auto-approve');
  });

  it('returns full-review when a non-markdown file is added', () => {
    expect(selectApprovalPath(baseDiff({ filesAdded: ['run.py'] }))).toBe('full-review');
  });

  it('returns full-review when a non-markdown file is modified', () => {
    expect(selectApprovalPath(baseDiff({ filesModified: ['src/run.ts'] }))).toBe('full-review');
  });

  it('returns full-review when a dependency is added', () => {
    expect(selectApprovalPath(baseDiff({ dependenciesAdded: { 'left-pad': '^1' } }))).toBe(
      'full-review',
    );
  });

  it('returns full-review when permissions are expanded', () => {
    expect(selectApprovalPath(baseDiff({ permissionsExpanded: true }))).toBe('full-review');
  });

  it('returns full-review when manifest kind changed', () => {
    expect(selectApprovalPath(baseDiff({ manifestKindChanged: true }))).toBe('full-review');
  });

  it('returns rescan-conditional for a dependency patch bump only', () => {
    expect(
      selectApprovalPath(
        baseDiff({ dependenciesChanged: { x: { from: '1.0.0', to: '1.0.1' } } }),
      ),
    ).toBe('rescan-conditional');
  });

  it('returns rescan-conditional when permissions are narrowed', () => {
    expect(
      selectApprovalPath(
        baseDiff({
          permissionsBefore: basePermissions({ network: true }),
          permissionsAfter: basePermissions({ network: false }),
          permissionsExpanded: false,
        }),
      ),
    ).toBe('rescan-conditional');
  });

  it('prefers full-review over rescan-conditional when both signals fire', () => {
    expect(
      selectApprovalPath(
        baseDiff({
          dependenciesChanged: { x: { from: '1.0.0', to: '1.0.1' } },
          permissionsExpanded: true,
        }),
      ),
    ).toBe('full-review');
  });

  it('treats unchanged permissions (same before and after) as not narrowed', () => {
    expect(
      selectApprovalPath(
        baseDiff({
          permissionsBefore: basePermissions(),
          permissionsAfter: basePermissions(),
          permissionsExpanded: false,
        }),
      ),
    ).toBe('auto-approve');
  });
});

describe('computeVersionDiff', () => {
  it('treats null from-snapshot as first publish with empty fromVersion and null fromContentHash', () => {
    const to = snapshot({
      version: '1.0.0',
      contentHash: 'sha256:to',
      files: { 'SKILL.md': 'blob:md', 'docs/INTRO.md': 'blob:intro' },
    });

    const diff = computeVersionDiff(null, to);

    expect(diff.skillName).toBe('demo');
    expect(diff.fromVersion).toBe('');
    expect(diff.fromContentHash).toBeNull();
    expect(diff.toVersion).toBe('1.0.0');
    expect(diff.toContentHash).toBe('sha256:to');
    expect(diff.filesAdded).toEqual(['SKILL.md', 'docs/INTRO.md'].sort());
    expect(diff.filesRemoved).toEqual([]);
    expect(diff.filesModified).toEqual([]);
    expect(diff.permissionsBefore).toBeNull();
    expect(diff.permissionsAfter).toEqual(basePermissions());
    expect(diff.manifestKindChanged).toBe(false);
    expect(diff.riskAssessment).toBe('low');
  });

  it('produces low risk for a markdown-only edit', () => {
    const from = snapshot({
      version: '1.0.0',
      contentHash: 'sha256:from',
      files: { 'SKILL.md': 'blob:md-1' },
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      files: { 'SKILL.md': 'blob:md-2' },
      manifest: baseManifest({ version: '1.0.1' }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.filesModified).toEqual(['SKILL.md']);
    expect(diff.filesAdded).toEqual([]);
    expect(diff.filesRemoved).toEqual([]);
    expect(diff.dependenciesAdded).toEqual({});
    expect(diff.permissionsExpanded).toBe(false);
    expect(diff.riskAssessment).toBe('low');
  });

  it('detects an added dependency and classifies as high', () => {
    const from = snapshot({
      manifest: baseManifest({ dependencies: { lodash: '^4.0.0' } }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({
        version: '1.0.1',
        dependencies: { lodash: '^4.0.0', axios: '^1.0.0' },
      }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.dependenciesAdded).toEqual({ axios: '^1.0.0' });
    expect(diff.dependenciesRemoved).toEqual({});
    expect(diff.dependenciesChanged).toEqual({});
    expect(diff.riskAssessment).toBe('high');
  });

  it('detects a changed dependency version range', () => {
    const from = snapshot({
      manifest: baseManifest({ dependencies: { lodash: '^4.0.0' } }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({
        version: '1.0.1',
        dependencies: { lodash: '^4.17.0' },
      }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.dependenciesChanged).toEqual({
      lodash: { from: '^4.0.0', to: '^4.17.0' },
    });
    expect(diff.riskAssessment).toBe('high');
  });

  it('detects a removed dependency', () => {
    const from = snapshot({
      manifest: baseManifest({ dependencies: { lodash: '^4.0.0' } }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({ version: '1.0.1', dependencies: {} }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.dependenciesRemoved).toEqual({ lodash: '^4.0.0' });
    expect(diff.dependenciesAdded).toEqual({});
    expect(diff.dependenciesChanged).toEqual({});
  });

  it('flags permissionsExpanded when network is newly granted', () => {
    const from = snapshot({
      manifest: baseManifest({ permissions: basePermissions() }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({
        version: '1.0.1',
        permissions: basePermissions({ network: true }),
      }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.permissionsExpanded).toBe(true);
    expect(diff.riskAssessment).toBe('high');
  });

  it('flags manifestKindChanged when kind changes', () => {
    const from = snapshot({
      manifest: baseManifest({ kind: 'skill' }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({ version: '1.0.1', kind: 'persona', persona_mode: 'inject' }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.manifestKindChanged).toBe(true);
    expect(diff.riskAssessment).toBe('high');
  });

  it('flags manifestKindChanged when persona_mode changes', () => {
    const from = snapshot({
      manifest: baseManifest({ kind: 'persona', persona_mode: 'inject' }),
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      manifest: baseManifest({ version: '1.0.1', kind: 'persona', persona_mode: 'delegate' }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.manifestKindChanged).toBe(true);
  });

  it('records removed files when the new snapshot drops a path', () => {
    const from = snapshot({
      files: { 'SKILL.md': 'blob:md', 'src/run.ts': 'blob:run' },
    });
    const to = snapshot({
      version: '1.0.1',
      contentHash: 'sha256:to',
      files: { 'SKILL.md': 'blob:md' },
      manifest: baseManifest({ version: '1.0.1' }),
    });

    const diff = computeVersionDiff(from, to);

    expect(diff.filesRemoved).toEqual(['src/run.ts']);
    expect(diff.filesAdded).toEqual([]);
    expect(diff.filesModified).toEqual([]);
  });

  it('stamps a valid ISO 8601 computedAt', () => {
    const diff = computeVersionDiff(null, snapshot());
    expect(() => new Date(diff.computedAt).toISOString()).not.toThrow();
    expect(diff.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
