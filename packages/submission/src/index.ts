import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { pathToFileURL } from 'node:url';
import { assertAuthModeAllowed } from './auth/entra.js';
import { authMiddleware } from './auth/middleware.js';
import type { AuthVariables } from './auth/types.js';
import { getEnv } from './env.js';
import { healthRoutes } from './http/health.js';
import { createWorkflowRoutes, type WorkflowRouteOptions } from './http/workflow.js';
import { mcpHandler } from './mcp/server.js';

assertAuthModeAllowed();

const env = getEnv();

export interface CreateAppOptions {
  workflow?: WorkflowRouteOptions;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', authMiddleware({ authMode: env.AUTH_MODE }));
  app.route('/health', healthRoutes);
  app.route('/healthz', healthRoutes);
  app.all('/mcp', mcpHandler);
  app.route('/api/v1/submissions', createWorkflowRoutes(options.workflow));
  app.route('/submissions', createWorkflowRoutes(options.workflow));

  return app;
}

export const app = createApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({
    fetch: app.fetch,
    port: env.PORT,
  });
}
