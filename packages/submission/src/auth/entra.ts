import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { apiError } from '../http/errors.js';
import type { AuthVariables, Identity } from './types.js';

export interface EntraAuthOptions {
  tenantId?: string;
  clientId?: string;
  jwks?: JWTVerifyGetKey;
}

export type VerifyBearerOptions = EntraAuthOptions;

interface AuthModeEnv {
  [key: string]: string | undefined;
  NODE_ENV?: string;
  AUTH_MODE?: string;
}

export function assertAuthModeAllowed(env: AuthModeEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
    throw new Error('FATAL: AUTH_MODE=mock is forbidden in production');
  }
}

export function entraJwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
}

function bearerToken(authorization: string | null | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function rolesFromPayload(roles: unknown): string[] {
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [];
}

function hasAccessAsUserScope(payload: JWTPayload): boolean {
  const scopeClaim =
    typeof payload.scp === 'string'
      ? payload.scp
      : typeof payload.scope === 'string'
        ? payload.scope
        : '';
  return scopeClaim.split(/\s+/).includes('access_as_user');
}

interface ResolvedEntraConfig {
  tenantId: string;
  clientId: string;
  jwks: JWTVerifyGetKey;
}

function resolveEntraConfig(options: EntraAuthOptions): ResolvedEntraConfig | undefined {
  const tenantId = options.tenantId ?? process.env.AZURE_TENANT_ID;
  const clientId = options.clientId ?? process.env.AZURE_CLIENT_ID;
  const jwks = options.jwks ?? (tenantId ? createRemoteJWKSet(entraJwksUrl(tenantId)) : undefined);
  if (!tenantId || !clientId || !jwks) {
    return undefined;
  }
  return { tenantId, clientId, jwks };
}

export async function verifyBearer(token: string, options: VerifyBearerOptions = {}): Promise<Identity> {
  const config = resolveEntraConfig(options);
  if (!config) {
    throw new Error('entra_not_configured');
  }
  const { payload } = await jwtVerify(token, config.jwks, {
    algorithms: ['RS256'],
    audience: config.clientId,
    issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
  });
  if (!hasAccessAsUserScope(payload)) {
    throw new Error('missing_access_as_user_scope');
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  return {
    sub,
    roles: rolesFromPayload(payload.roles),
  };
}

export function entraAuth(options: EntraAuthOptions = {}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const config = resolveEntraConfig(options);

  return async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token || !config) {
      return apiError(c, 401, 'authentication_required');
    }

    try {
      const identity = await verifyBearer(token, config);
      c.set('identity', identity);
      await next();
    } catch {
      return apiError(c, 401, 'authentication_required');
    }
  };
}
