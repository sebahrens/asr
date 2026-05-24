import { describe, expect, it } from 'vitest';

import { compareVersions, gtVersion, isValidVersion, rsortVersions } from './version.js';

describe('version helpers', () => {
  it('validates strict semver versions', () => {
    expect(isValidVersion('1.2.0')).toBe(true);
    expect(isValidVersion('1.2')).toBe(false);
  });

  it('compares versions', () => {
    expect(gtVersion('1.0.0', '1.1.0')).toBe(false);
    expect(gtVersion('1.1.0', '1.0.0')).toBe(true);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('sorts versions in descending order without mutating input', () => {
    const versions = ['1.0.0', '1.2.0', '1.1.0'];

    expect(rsortVersions(versions)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(versions).toEqual(['1.0.0', '1.2.0', '1.1.0']);
  });
});
