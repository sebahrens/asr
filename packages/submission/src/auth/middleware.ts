import type { MiddlewareHandler } from 'hono';
import { apiError } from '../http/errors.js';
import { entraAuth, type EntraAuthOptions } from './entra.js';
import { mockAuth } from './mockAuth.js';
import { isExemptPath } from './requireRole.js';
import type { AuthVariables } from './types.js';

export interface AuthMiddlewareOptions extends EntraAuthOptions {
  authMode?: string;
}

export function authMiddleware(options: AuthMiddlewareOptions = {}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const authMode = options.authMode ?? process.env.AUTH_MODE;
  const delegate =
    authMode === 'mock'
      ? mockAuth()
      : authMode === 'entra'
        ? entraAuth(options)
        : undefined;

  return async (c, next) => {
    if (isExemptPath(c.req.path)) {
      await next();
      return;
    }

    if (!delegate) {
      return apiError(c, 401, 'authentication_required');
    }

    return delegate(c, next);
  };
}
