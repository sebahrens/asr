import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { resolveMcpPrincipal } from './auth.js';
import { MCP_ERROR, McpToolError } from './errors.js';

async function signedToken(roles: string[] = ['Submitter']) {
  const tenantId = 'tenant-1';
  const clientId = 'client-1';
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
  });

  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('user-1')
    .setAudience(clientId)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  return { tenantId, clientId, jwks, token };
}

describe('resolveMcpPrincipal (AUTH_MODE=entra)', () => {
  it('rejects with authentication_required (-32002) when Authorization header is missing', async () => {
    const { tenantId, clientId, jwks } = await signedToken();
    const req = new Request('https://example.test/mcp', { method: 'POST' });

    await expect(
      resolveMcpPrincipal(req, { authMode: 'entra', tenantId, clientId, jwks }),
    ).rejects.toMatchObject({
      name: 'McpToolError',
      code: MCP_ERROR.authentication_required,
      message: 'authentication_required',
    });
  });

  it('rejects with authentication_required when bearer token cannot be verified', async () => {
    const { tenantId, clientId, jwks } = await signedToken();
    const req = new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-jwt' },
    });

    const err = await resolveMcpPrincipal(req, {
      authMode: 'entra',
      tenantId,
      clientId,
      jwks,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });

  it('resolves to {sub, roles} for a valid Submitter token', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken(['Submitter', 'Compliance']);
    const req = new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    await expect(
      resolveMcpPrincipal(req, { authMode: 'entra', tenantId, clientId, jwks }),
    ).resolves.toEqual({
      sub: 'user-1',
      roles: ['Submitter', 'Compliance'],
    });
  });

  it('resolves to {sub, roles} for a valid Compliance-only token', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken(['Compliance']);
    const req = new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    await expect(
      resolveMcpPrincipal(req, { authMode: 'entra', tenantId, clientId, jwks }),
    ).resolves.toEqual({
      sub: 'user-1',
      roles: ['Compliance'],
    });
  });

  it('rejects with insufficient_permissions (-32001) when token has no MCP role', async () => {
    const { tenantId, clientId, jwks, token } = await signedToken(['Observer']);
    const req = new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const err = await resolveMcpPrincipal(req, {
      authMode: 'entra',
      tenantId,
      clientId,
      jwks,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe(MCP_ERROR.insufficient_permissions);
    expect((err as McpToolError).message).toBe('insufficient_permissions');
    expect((err as McpToolError).data).toEqual({
      required: 'Submitter or Compliance',
      actual: ['Observer'],
    });
  });
});

describe('resolveMcpPrincipal (AUTH_MODE=mock)', () => {
  it('resolves to the mock principal with no Authorization header', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'mock-user');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter,Compliance');

    const req = new Request('https://example.test/mcp', { method: 'POST' });

    await expect(resolveMcpPrincipal(req, { authMode: 'mock' })).resolves.toEqual({
      sub: 'mock-user',
      roles: ['Submitter', 'Compliance'],
    });

    vi.unstubAllEnvs();
  });

  it('resolves to a Compliance-only mock principal', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'mock-user');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');

    const req = new Request('https://example.test/mcp', { method: 'POST' });

    await expect(resolveMcpPrincipal(req, { authMode: 'mock' })).resolves.toEqual({
      sub: 'mock-user',
      roles: ['Compliance'],
    });

    vi.unstubAllEnvs();
  });

  it('rejects with insufficient_permissions when mock principal lacks an MCP role', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'mock-user');
    vi.stubEnv('MOCK_USER_ROLES', 'Observer');

    const req = new Request('https://example.test/mcp', { method: 'POST' });

    const err = await resolveMcpPrincipal(req, { authMode: 'mock' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe(MCP_ERROR.insufficient_permissions);

    vi.unstubAllEnvs();
  });
});
