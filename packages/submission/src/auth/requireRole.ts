import type { MiddlewareHandler } from 'hono';
import { apiError } from '../http/errors.js';
import type { AuthVariables, Identity } from './types.js';

export const EXEMPT_PATHS = ['/health', '/api/health', '/healthz', '/version'] as const;

export function isExemptPath(path: string): boolean {
  return (
    EXEMPT_PATHS.includes(path as (typeof EXEMPT_PATHS)[number]) ||
    path.startsWith('/api/v1/skills') ||
    path.startsWith('/webhooks/')
  );
}

export function requireRole(...roles: string[]): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const identity: Identity | undefined = c.get('identity');

    if (!identity) {
      return apiError(c, 401, 'authentication_required');
    }

    const hasRequiredRole = identity.roles.some((role) => roles.includes(role));
    if (!hasRequiredRole) {
      return apiError(c, 403, 'insufficient_permissions', { required: roles.join(',') });
    }

    await next();
  };
}
