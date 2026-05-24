import semver from 'semver';

export function isValidVersion(v: string): boolean {
  return semver.valid(v) !== null;
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
