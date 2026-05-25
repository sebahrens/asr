import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { createApp as CreateApp } from '../index.js';
import { MCP_PROTOCOL_VERSION } from './server.js';

let createApp: typeof CreateApp;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');

  ({ createApp } = await import('../index.js'));
});

describe('mcpHandler', () => {
  it('initializes a Streamable HTTP MCP session', async () => {
    const app = createApp();
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'asr-test', version: '0.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'asr-registry', version: '0.1.0' },
      },
    });
  });
});
