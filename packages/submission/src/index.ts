import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { pathToFileURL } from 'node:url';
import { assertAuthModeAllowed } from './auth/entra.js';
import { authMiddleware } from './auth/middleware.js';
import type { AuthVariables } from './auth/types.js';
import { getEnv } from './env.js';
import { createAuditRoutes, type AuditRouteOptions } from './http/audit.js';
import { healthRoutes } from './http/health.js';
import { createRegistryRoutes, type RegistryRouteOptions } from './http/registry.js';
import { createSubmissionRoutes, type SubmissionRouteOptions } from './http/submissions.js';
import { createWorkflowRoutes, type WorkflowRouteOptions } from './http/workflow.js';
import { createYankRoutes, type YankRouteOptions } from './http/yank.js';
import { createMcpRoute, type McpRouteOptions } from './mcp/server.js';

assertAuthModeAllowed();

const env = getEnv();

export interface CreateAppOptions {
  registry?: RegistryRouteOptions;
  submissions?: SubmissionRouteOptions;
  workflow?: WorkflowRouteOptions;
  mcp?: McpRouteOptions;
  audit?: AuditRouteOptions;
  yank?: YankRouteOptions;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', devCorsMiddleware);
  app.route('/health', healthRoutes);
  app.route('/api/health', healthRoutes);
  app.route('/api/v1/skills', createRegistryRoutes(options.registry));
  app.all('/mcp', createMcpRoute(options.mcp));
  app.use('*', authMiddleware({ authMode: env.AUTH_MODE }));
  app.route('/api/v1/submissions', createSubmissionRoutes(options.submissions));
  app.route('/api/v1/submissions', createWorkflowRoutes(options.workflow));
  app.route('/submissions', createWorkflowRoutes(options.workflow));
  app.route('/api/v1/skills', createYankRoutes(options.yank));
  app.route('/api/v1/audit', createAuditRoutes(options.audit));

  return app;
}

const devCorsMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin || !isDevCorsOrigin(origin)) {
    await next();
    return;
  }

  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  c.header('Vary', 'Origin');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
};

function isDevCorsOrigin(origin: string): boolean {
  if (env.AUTH_MODE !== 'mock' && process.env.NODE_ENV === 'production') {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      ['5173', '3000', '4173'].includes(url.port)
    );
  } catch {
    return false;
  }
}

export const app = createApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({
    fetch: app.fetch,
    port: env.PORT,
  });
}
