import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { apiError } from '../http/errors.js';
import type { AuthVariables, Identity } from './types.js';

export interface EntraAuthOptions {
  tenantId?: string;
  clientId?: string;
  jwks?: JWTVerifyGetKey;
}

export function entraJwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function rolesFromPayload(roles: unknown): string[] {
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];
}

export function entraAuth(options: EntraAuthOptions = {}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const tenantId = options.tenantId ?? process.env.AZURE_TENANT_ID;
  const clientId = options.clientId ?? process.env.AZURE_CLIENT_ID;
  const jwks = options.jwks ?? (tenantId ? createRemoteJWKSet(entraJwksUrl(tenantId)) : undefined);

  return async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token || !tenantId || !clientId || !jwks) {
      return apiError(c, 401, 'authentication_required');
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: clientId,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      });

      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const identity: Identity = {
        sub,
        roles: rolesFromPayload(payload.roles),
      };

      c.set('identity', identity);
      await next();
    } catch {
      return apiError(c, 401, 'authentication_required');
    }
  };
}
