import { Hono } from 'hono';

export interface VersionRouteOptions {
  buildSha?: string;
  specVersion?: string;
  serviceVersion?: string;
}

export function createVersionRoutes(options: VersionRouteOptions = {}) {
  const routes = new Hono();
  routes.get('/', (c) =>
    c.json({
      version: options.serviceVersion ?? process.env.npm_package_version ?? '0.1.0',
      buildSha:
        options.buildSha ??
        process.env.BUILD_SHA ??
        process.env.GIT_SHA ??
        process.env.COMMIT_SHA ??
        'dev',
      specVersion: options.specVersion ?? process.env.ASR_SPEC_VERSION ?? '0.1.0',
    }),
  );
  return routes;
}
