import type { MiddlewareHandler } from 'hono';
import type { AuthVariables } from './types.js';

export function mockAuth(): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const identity = {
      sub: process.env.MOCK_USER_SUB ?? '',
      roles: (process.env.MOCK_USER_ROLES ?? '')
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
    };

    c.set('identity', identity);
    await next();
  };
}
