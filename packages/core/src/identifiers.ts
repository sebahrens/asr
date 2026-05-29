import semver from 'semver';

export const SKILL_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidSkillIdentifier(value: string): boolean {
  return SKILL_IDENTIFIER_PATTERN.test(value);
}

export function isValidSkillVersion(value: string): boolean {
  return semver.valid(value) === value;
}
