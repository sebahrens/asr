import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Handler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Identity } from '../auth/types.js';
import { resolveMcpPrincipal } from './auth.js';
import { McpToolError, mcpError } from './errors.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_VERSION = '0.1.0';

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  principal: Identity;
}

const sessions = new Map<string, McpSession>();

export function createMcpServer(): McpServer {
  return new McpServer({
    name: 'asr-registry',
    version: SERVER_VERSION,
  });
}

export const mcpHandler: Handler = async (c) => {
  if (c.req.method === 'GET') {
    const session = getSession(c.req.header('mcp-session-id'));
    if (!session) {
      return sessionNotFound(c);
    }
    return session.transport.handleRequest(c.req.raw, {
      authInfo: authInfoFor(session.principal),
    });
  }

  if (c.req.method === 'DELETE') {
    const sessionId = c.req.header('mcp-session-id');
    const session = getSession(sessionId);
    if (!session) {
      return sessionNotFound(c);
    }
    const response = await session.transport.handleRequest(c.req.raw, {
      authInfo: authInfoFor(session.principal),
    });
    if (response.ok && sessionId) {
      sessions.delete(sessionId);
    }
    return response;
  }

  if (c.req.method !== 'POST') {
    return c.json(jsonRpcError(-32000, 'Method not allowed', null), 405, {
      Allow: 'GET, POST, DELETE',
    });
  }

  const body = await readJson(c.req.raw);
  if (body === undefined) {
    return c.json(jsonRpcError(-32700, 'Parse error', null), 400);
  }

  const sessionId = c.req.header('mcp-session-id');
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return c.json(jsonRpcError(-32000, 'MCP session not found', extractId(body)), 404);
    }
    return session.transport.handleRequest(c.req.raw, {
      parsedBody: body,
      authInfo: authInfoFor(session.principal),
    });
  }

  if (!isInitializeRequest(body)) {
    return c.json(jsonRpcError(-32000, 'MCP session not found', extractId(body)), 400);
  }

  let principal: Identity;
  try {
    principal = await resolveMcpPrincipal(c.req.raw);
  } catch (err) {
    if (err instanceof McpToolError) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: mcpError(err.code, err.message, err.data),
          id: extractId(body),
        },
        401,
      );
    }
    throw err;
  }

  const transport = await createTransportForInitialize(principal);
  return transport.handleRequest(c.req.raw, {
    parsedBody: body,
    authInfo: authInfoFor(principal),
  });
};

function getSession(sessionId: string | undefined): McpSession | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

function sessionNotFound(c: Parameters<Handler>[0]): Response {
  return c.json(jsonRpcError(-32000, 'MCP session not found', null), 404);
}

async function createTransportForInitialize(
  principal: Identity,
): Promise<WebStandardStreamableHTTPServerTransport> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(sessionId) {
      sessions.set(sessionId, { transport, principal });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  await createMcpServer().connect(transport);
  return transport;
}

function authInfoFor(principal: Identity): AuthInfo {
  return {
    token: '',
    clientId: '',
    scopes: principal.roles,
    extra: { principal },
  };
}

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'method' in body &&
    body.method === 'initialize'
  );
}

function extractId(body: unknown): string | number | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    (typeof (body as { id: unknown }).id === 'string' ||
      typeof (body as { id: unknown }).id === 'number')
  ) {
    return (body as { id: string | number }).id;
  }
  return null;
}

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function jsonRpcError(code: number, message: string, id: string | number | null) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id,
  };
}

export { MCP_PROTOCOL_VERSION };
