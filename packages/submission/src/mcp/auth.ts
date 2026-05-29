import { verifyBearer, type VerifyBearerOptions } from '../auth/entra.js';
import type { Identity } from '../auth/types.js';
import { MCP_ERROR, McpToolError } from './errors.js';

const MCP_SESSION_ROLES = ['Submitter', 'Compliance'] as const;
const MCP_SESSION_ROLE_SET = new Set<string>(MCP_SESSION_ROLES);

export interface ResolveMcpPrincipalOptions extends VerifyBearerOptions {
  authMode?: string;
}

function bearerToken(authorization: string | null | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function mockPrincipal(): Identity {
  return {
    sub: process.env.MOCK_USER_SUB ?? '',
    roles: (process.env.MOCK_USER_ROLES ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  };
}

export async function resolveMcpPrincipal(
  req: Request,
  options: ResolveMcpPrincipalOptions = {},
): Promise<Identity> {
  const authMode = options.authMode ?? process.env.AUTH_MODE;

  let identity: Identity;
  if (authMode === 'mock') {
    identity = mockPrincipal();
  } else {
    const token = bearerToken(req.headers.get('Authorization'));
    if (!token) {
      throw new McpToolError(MCP_ERROR.authentication_required, 'authentication_required');
    }
    try {
      identity = await verifyBearer(token, options);
    } catch {
      throw new McpToolError(MCP_ERROR.authentication_required, 'authentication_required');
    }
  }

  if (!identity.roles.some((role) => MCP_SESSION_ROLE_SET.has(role))) {
    throw new McpToolError(MCP_ERROR.insufficient_permissions, 'insufficient_permissions', {
      required: MCP_SESSION_ROLES.join(' or '),
      actual: identity.roles,
    });
  }

  return identity;
}
