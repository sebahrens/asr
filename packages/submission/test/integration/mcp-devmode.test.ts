import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { createApp as CreateApp } from '../../src/index.js';

// Smoke test: an MCP client following the published dev-mode .mcp.json
// (no Authorization header, AUTH_MODE=mock) can complete the initialize
// handshake against the running Hono app and enumerate the registered
// tools via tools/list. Proves the dev-mode block in specs/mcp.md
// actually connects end-to-end.

let createApp: typeof CreateApp;
let server: ServerType;
let baseUrl: URL;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter');

  ({ createApp } = await import('../../src/index.js'));

  const app = createApp();

  // port 0 → kernel-assigned ephemeral port
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected AddressInfo from node:net for the test server');
  }
  baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('mcp dev-mode connectivity', () => {
  it('initializes and lists tools with no Authorization header', async () => {
    const transport = new StreamableHTTPClientTransport(baseUrl);
    const client = new Client(
      { name: 'asr-devmode-smoke', version: '0.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('registry_search');
    } finally {
      await client.close();
    }
  });
});
