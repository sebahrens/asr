import { env } from './env.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { pathToFileURL } from 'node:url';
import { healthRoutes } from './http/health.js';

export const app = new Hono();

app.route('/healthz', healthRoutes);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({
    fetch: app.fetch,
    port: env.PORT,
  });
}
