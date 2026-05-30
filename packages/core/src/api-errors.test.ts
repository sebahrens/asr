import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_ERRORS, isApiError } from './api-errors.js';

describe('API_ERRORS', () => {
  it('matches the closed union documented in specs/api.md', () => {
    const specPath = fileURLToPath(new URL('../../../specs/api.md', import.meta.url));
    const spec = readFileSync(specPath, 'utf8');
    const match = spec.match(/type ApiError =\n(?<body>(?:  \| '[^']+';?\n?)+)/);

    expect(match?.groups?.body).toBeDefined();

    const documented = Array.from(match?.groups?.body.matchAll(/\| '([^']+)'/g) ?? []).map(
      ([, code]) => code,
    );

    expect(documented).toEqual([...API_ERRORS]);
  });

  it('recognizes only canonical API error codes', () => {
    expect(isApiError('version_already_exists')).toBe(true);
    expect(isApiError('unauthorized')).toBe(false);
    expect(isApiError(undefined)).toBe(false);
  });
});
