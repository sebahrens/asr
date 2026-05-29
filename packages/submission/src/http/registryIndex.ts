import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import {
  readRegistryIndexFile,
  regenerateRegistryIndex,
  type RegistryIndexOptions,
} from '../jobs/registryIndex.js';
import { apiError } from './errors.js';

export interface RegistryIndexRouteOptions extends RegistryIndexOptions {
  db?: Database.Database;
}

export async function registryIndexHandler(
  c: Context,
  options: RegistryIndexRouteOptions = {},
): Promise<Response> {
  let file;
  try {
    file = await readRegistryIndexFile(options.path);
  } catch (error) {
    if (!options.db) {
      return apiError(c, 404, 'submission_not_found');
    }
    file = await regenerateRegistryIndex(options.db, options);
  }

  c.header('Cache-Control', 'public, max-age=60');
  c.header('ETag', file.etag);
  c.header('Last-Modified', file.lastModified.toUTCString());
  c.header('Content-Type', 'application/json; charset=utf-8');

  if (c.req.header('If-None-Match') === file.etag) {
    return c.body(null, 304);
  }

  return c.body(file.content);
}
