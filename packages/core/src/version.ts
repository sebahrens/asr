import semver from 'semver';
import { isValidSkillVersion } from './identifiers.js';

export type VersionUpgradeError = 'invalid_format' | 'not_greater';

export function isValidVersion(v: string): boolean {
  return isValidSkillVersion(v);
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return semver.compare(a, b);
}

export function gtVersion(a: string, b: string): boolean {
  return semver.gt(a, b);
}

export function rsortVersions(vs: string[]): string[] {
  return semver.rsort([...vs]);
}

export function validateVersionUpgrade(
  next: string,
  current: string | null,
): { ok: true } | { ok: false; error: VersionUpgradeError } {
  if (!isValidVersion(next)) {
    return { ok: false, error: 'invalid_format' };
  }

  if (current === null) {
    return { ok: true };
  }

  if (!gtVersion(next, current)) {
    return { ok: false, error: 'not_greater' };
  }

  return { ok: true };
}
