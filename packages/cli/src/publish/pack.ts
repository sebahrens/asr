import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { zipSync, type Zippable } from 'fflate';

const SKIP_DIRS = new Set(['node_modules', '.git']);

const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

export interface PackSkillDirResult {
  buffer: Buffer;
  files: string[];
}

export async function packSkillDir(dir: string): Promise<PackSkillDirResult> {
  const zippable: Zippable = {};
  const files: string[] = [];

  await collect(dir, dir, zippable, files);

  files.sort();
  const sorted: Zippable = {};
  for (const rel of files) {
    sorted[rel] = zippable[rel];
  }

  const bytes = zipSync(sorted);
  return { buffer: Buffer.from(bytes), files };
}

async function collect(
  root: string,
  current: string,
  zippable: Zippable,
  files: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(root, join(current, entry.name), zippable, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const full = join(current, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    const content = await readFile(full);

    zippable[rel] = [new Uint8Array(content), { mtime: FIXED_MTIME }];
    files.push(rel);
  }
}
