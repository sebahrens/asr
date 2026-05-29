import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  canonicalHash,
  canonicalHashFromDigests,
  type CanonicalFile,
  isCanonicalExcluded,
} from './hash.js';

describe('isCanonicalExcluded', () => {
  it('excludes OS cruft and VCS metadata paths', () => {
    expect(isCanonicalExcluded('.DS_Store')).toBe(true);
    expect(isCanonicalExcluded('sub/.DS_Store')).toBe(true);
    expect(isCanonicalExcluded('__MACOSX/foo')).toBe(true);
    expect(isCanonicalExcluded('.git/config')).toBe(true);
    expect(isCanonicalExcluded('a/.git/HEAD')).toBe(true);
  });

  it('keeps ordinary skill files', () => {
    expect(isCanonicalExcluded('SKILL.md')).toBe(false);
    expect(isCanonicalExcluded('src/index.ts')).toBe(false);
    expect(isCanonicalExcluded('assets/logo.png')).toBe(false);
  });
});

describe('canonicalHash', () => {
  const encoder = new TextEncoder();

  const files = (): CanonicalFile[] => [
    { path: 'SKILL.md', content: encoder.encode('# Skill\n') },
    { path: 'scripts/run.sh', content: encoder.encode('echo ok\n'), executable: true },
  ];

  it('is independent of input order', () => {
    const forward = files();
    const reversed = [...forward].reverse();

    expect(canonicalHash(reversed)).toBe(canonicalHash(forward));
  });

  it('ignores canonical excluded paths', () => {
    const base = files();
    const withCruft: CanonicalFile[] = [
      ...base,
      { path: '.DS_Store', content: encoder.encode('finder metadata') },
      { path: '__MACOSX/x', content: encoder.encode('mac resource fork') },
    ];

    expect(canonicalHash(withCruft)).toBe(canonicalHash(base));
  });

  it('changes when file content changes', () => {
    const base = files();
    const changed = files();
    changed[0] = { ...changed[0], content: encoder.encode('# Skill!\n') };

    expect(canonicalHash(changed)).not.toBe(canonicalHash(base));
  });

  it('matches the digest-based canonical hash', () => {
    const base = files();
    const digests = base.map((file) => ({
      path: file.path,
      size: file.content.length,
      sha256: createHash('sha256').update(file.content).digest(),
      executable: file.executable,
    }));

    expect(canonicalHashFromDigests(digests)).toBe(canonicalHash(base));
  });
});
