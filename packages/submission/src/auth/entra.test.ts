import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { entraAuth } from './entra.js';
import type { AuthVariables } from './types.js';

async function signedToken() {
  const tenantId = 'tenant-1';
  const clientId = 'client-1';
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
  });

  const token = await new SignJWT({ roles: ['Compliance'] })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('user-1')
    .setAudience(clientId)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  return { tenantId, clientId, jwks, token };
}

describe('entraAuth', () => {
  it('verifies a bearer token and injects the identity', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', entraAuth({ tenantId, clientId, jwks }));
    app.get('/', (c) => c.json(c.get('identity')));

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sub: 'user-1',
      roles: ['Compliance'],
    });
  });

  it('returns 401 when Authorization is missing', async () => {
    const { tenantId, clientId, jwks } = await signedToken();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', entraAuth({ tenantId, clientId, jwks }));
    app.get('/', (c) => c.json({ ok: true }));

    const res = await app.request('/');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
  });
});
