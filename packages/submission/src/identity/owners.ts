import { createHash } from 'node:crypto';

const MAX_OWNER_LENGTH = 64;

export function ownerFromPrincipal(submittedBy: string): string {
  const normalized = submittedBy
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_OWNER_LENGTH)
    .replace(/-+$/g, '');

  if (normalized.length > 0) {
    return normalized;
  }

  const digest = createHash('sha256').update(submittedBy).digest('hex').slice(0, 12);
  return `principal-${digest}`;
}
