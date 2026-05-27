import { describe, expect, it } from 'vitest';

import { assessRisk } from './versionDiff.js';
import type { PermissionsManifest, VersionDiff } from './types.js';

function basePermissions(overrides: Partial<PermissionsManifest> = {}): PermissionsManifest {
  return {
    network: false,
    subprocess: false,
    filesystem: 'none',
    environment: [],
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
