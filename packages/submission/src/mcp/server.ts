import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Handler } from 'hono';
import { randomUUID } from 'node:crypto';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_VERSION = '0.1.0';

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

export function createMcpServer(): McpServer {
  return new McpServer({
    name: 'asr-registry',
    version: SERVER_VERSION,
  });
}

export const mcpHandler: Handler = async (c) => {
  if (c.req.method === 'GET') {
    const transport = getTransportForSession(c.req.header('mcp-session-id'));
    if (!transport) {
      return sessionNotFound(c);
    }

    return transport.handleRequest(c.req.raw);
  }

  if (c.req.method === 'DELETE') {
    const sessionId = c.req.header('mcp-session-id');
    const transport = getTransportForSession(sessionId);
    if (!transport) {
      return sessionNotFound(c);
    }

    const response = await transport.handleRequest(c.req.raw);
    if (response.ok && sessionId) {
      sessions.delete(sessionId);
    }
    return response;
  }

  if (c.req.method !== 'POST') {
    return c.json(jsonRpcError(-32000, 'Method not allowed'), 405, { Allow: 'GET, POST, DELETE' });
  }

  const body = await readJson(c.req.raw);
  if (body === undefined) {
    return c.json(jsonRpcError(-32700, 'Parse error'), 400);
  }

  const sessionId = c.req.header('mcp-session-id');
  const transport = sessionId ? sessions.get(sessionId) : await createTransportForInitialize(body);
  if (!transport) {
    return c.json(jsonRpcError(-32000, 'MCP session not found'), sessionId ? 404 : 400);
  }

  return transport.handleRequest(c.req.raw, { parsedBody: body });
};

function getTransportForSession(sessionId: string | undefined): WebStandardStreamableHTTPServerTransport | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

function sessionNotFound(c: Parameters<Handler>[0]): Response {
  return c.json(jsonRpcError(-32000, 'MCP session not found'), 404);
}

async function createTransportForInitialize(body: unknown): Promise<WebStandardStreamableHTTPServerTransport | undefined> {
  if (!isInitializeRequest(body)) {
    return undefined;
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(sessionId) {
      sessions.set(sessionId, transport);
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

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'method' in body &&
    body.method === 'initialize'
  );
}

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function jsonRpcError(code: number, message: string) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  };
}

export { MCP_PROTOCOL_VERSION };
