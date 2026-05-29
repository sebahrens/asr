import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { describe, expect, it } from 'vitest';
import { entraAuth, verifyBearer } from './entra.js';
import type { AuthVariables, Identity } from './types.js';

async function signedToken(
  options: {
    audience?: string;
    claims?: Record<string, unknown>;
    expirationTime?: string;
    includeScp?: boolean;
    issuer?: string;
    signingKey?: CryptoKey | KeyLike;
    subject?: string | null;
  } = {},
) {
  const tenantId = 'tenant-1';
  const clientId = 'client-1';
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
  });

  const claims: Record<string, unknown> = { roles: ['Compliance'], ...options.claims };
  if (options.includeScp !== false) {
    claims.scp = 'access_as_user';
  }

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setAudience(options.audience ?? clientId)
    .setIssuer(options.issuer ?? issuer)
    .setIssuedAt()
    .setExpirationTime(options.expirationTime ?? '5m');
  if (options.subject !== null) {
    builder.setSubject(options.subject ?? 'user-1');
  }
  const token = await builder.sign(options.signingKey ?? privateKey);

  return { tenantId, clientId, jwks, token };
}

async function requestWithEntraAuth(options: {
  authorization?: string;
  clientId: string;
  jwks: Awaited<ReturnType<typeof signedToken>>['jwks'];
  tenantId: string;
}) {
  let observedIdentity: Identity | undefined;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', entraAuth({ tenantId: options.tenantId, clientId: options.clientId, jwks: options.jwks }));
  app.get('/', (c) => {
    observedIdentity = c.get('identity');
    return c.json({ ok: true });
  });

  const headers = options.authorization ? { Authorization: options.authorization } : undefined;
  const res = await app.request('/', { headers });
  return { observedIdentity, res };
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
    await expect(res.json()).resolves.toMatchObject({
      sub: 'user-1',
      roles: ['Compliance'],
      tokenExpiresAt: expect.any(Number),
    });
  });

  it('accepts access_as_user from the scope claim', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken({
      claims: { scope: 'offline_access access_as_user' },
      includeScp: false,
    });

    await expect(verifyBearer(token, { tenantId, clientId, jwks })).resolves.toMatchObject({
      sub: 'user-1',
      roles: ['Compliance'],
      tokenExpiresAt: expect.any(Number),
    });
  });

  it.each([
    { name: 'missing sub', tokenOptions: { subject: null } },
    { name: 'empty sub', tokenOptions: { claims: { sub: '' }, subject: null } },
    { name: 'non-string sub', tokenOptions: { claims: { sub: 42 }, subject: null } },
  ])('throws for a verified token with $name', async ({ tokenOptions }) => {
    const { tenantId, clientId, jwks, token } = await signedToken(tokenOptions);

    await expect(verifyBearer(token, { tenantId, clientId, jwks })).rejects.toThrow(
      'missing_subject',
    );
  });

  it('returns 401 when Authorization is missing', async () => {
    const { tenantId, clientId, jwks } = await signedToken();
    const { observedIdentity, res } = await requestWithEntraAuth({ tenantId, clientId, jwks });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(observedIdentity).toBeUndefined();
  });

  it.each([
    {
      name: 'expired token',
      tokenOptions: { expirationTime: '-1m' },
    },
    {
      name: 'wrong audience',
      tokenOptions: { audience: 'wrong-client' },
    },
    {
      name: 'wrong issuer',
      tokenOptions: { issuer: 'https://attacker.example/v2.0' },
    },
  ])('returns 401 for $name', async ({ tokenOptions }) => {
    const { tenantId, clientId, jwks, token } = await signedToken(tokenOptions);
    const { observedIdentity, res } = await requestWithEntraAuth({
      authorization: `Bearer ${token}`,
      tenantId,
      clientId,
      jwks,
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(observedIdentity).toBeUndefined();
  });

  it('returns 401 for a token signed by a key outside the configured JWKS', async () => {
    const { privateKey: attackerKey } = await generateKeyPair('RS256');
    const { tenantId, clientId, jwks, token } = await signedToken({ signingKey: attackerKey });
    const { observedIdentity, res } = await requestWithEntraAuth({
      authorization: `Bearer ${token}`,
      tenantId,
      clientId,
      jwks,
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(observedIdentity).toBeUndefined();
  });

  it('returns 401 for a malformed bearer token', async () => {
    const { tenantId, clientId, jwks } = await signedToken();
    const { observedIdentity, res } = await requestWithEntraAuth({
      authorization: 'Bearer not.a.jwt',
      tenantId,
      clientId,
      jwks,
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(observedIdentity).toBeUndefined();
  });

  it('returns 401 for an app-only token without access_as_user delegated scope', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken({
      claims: { idtyp: 'app', roles: ['Compliance'] },
      includeScp: false,
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', entraAuth({ tenantId, clientId, jwks }));
    app.get('/', (c) => c.json(c.get('identity')));

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('rejects verified tokens signed with non-RS256 algorithms', async () => {
    const tenantId = 'tenant-1';
    const clientId = 'client-1';
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const kid = 'test-key-ec';
    const jwks = createLocalJWKSet({
      keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }],
    });

    const token = await new SignJWT({ roles: ['Compliance'], scp: 'access_as_user' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('user-1')
      .setAudience(clientId)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifyBearer(token, { tenantId, clientId, jwks })).rejects.toThrow();
  });
});
