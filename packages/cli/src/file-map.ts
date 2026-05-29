import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { PathTraversalError } from './extract.js';

export class InvalidFileMapError extends Error {
  readonly code = 'install.invalid_file_map' as const;

  constructor(message = 'Registry download response must contain a files object with string contents') {
    super(message);
    this.name = 'InvalidFileMapError';
  }
}

export function parseFileMapResponse(data: unknown): Record<string, string> {
  if (!isRecord(data) || !isRecord(data.files)) {
    throw new InvalidFileMapError();
  }

  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(data.files)) {
    if (typeof content !== 'string') {
      throw new InvalidFileMapError(`File content for ${path} must be a string`);
    }
    files[path] = content;
  }

  return files;
}

export async function writeValidatedFileMap(
  targetDir: string,
  files: Record<string, string>,
): Promise<string[]> {
  const validated = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    fullPath: validateFileMapPath(targetDir, path),
  }));

  await mkdir(targetDir, { recursive: true });
  for (const { fullPath, content } of validated) {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  return validated.map(({ fullPath }) =>
    relative(resolve(targetDir), fullPath).split(sep).join('/'),
  );
}

function validateFileMapPath(targetDir: string, path: string): string {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.startsWith('/') ||
    path.startsWith('\\')
  ) {
    throw new PathTraversalError(path);
  }

  if (path.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new PathTraversalError(path);
  }

  const canonical = resolve(targetDir);
  const fullPath = resolve(join(canonical, path));
  const rel = relative(canonical, fullPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathTraversalError(path);
  }

  return fullPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
