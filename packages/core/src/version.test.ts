import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  gtVersion,
  isValidVersion,
  rsortVersions,
  validateVersionUpgrade,
} from './version.js';

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

  it('validates version upgrades', () => {
    expect(validateVersionUpgrade('1.1.0', '1.0.0').ok).toBe(true);
    expect(validateVersionUpgrade('1.0.0', '1.0.0')).toEqual({
      ok: false,
      error: 'not_greater',
    });
    expect(validateVersionUpgrade('0.9.0', '1.0.0')).toEqual({
      ok: false,
      error: 'not_greater',
    });
    expect(validateVersionUpgrade('1.0.0', null).ok).toBe(true);
    expect(validateVersionUpgrade('1.2', '1.0.0')).toEqual({
      ok: false,
      error: 'invalid_format',
    });
  });
});
