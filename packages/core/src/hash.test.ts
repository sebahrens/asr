import { describe, expect, it } from 'vitest';

import { isCanonicalExcluded } from './hash.js';

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
