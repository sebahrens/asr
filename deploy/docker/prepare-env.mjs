#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '.env');
const examplePath = resolve(here, '.env.example');

const requiredSecrets = new Map([
  ['FORGEJO_SECRET_KEY', () => randomBytes(32).toString('base64url')],
  ['FORGEJO_INTERNAL_TOKEN', () => randomBytes(32).toString('base64url')],
]);

const existing = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
  : readFileSync(examplePath, 'utf8');

const lines = existing.split(/\r?\n/);
const seen = new Set();
let changed = !existsSync(envPath);

const updatedLines = lines.map((line) => {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) {
    return line;
  }

  const [, key, value] = match;
  if (!requiredSecrets.has(key)) {
    return line;
  }

  seen.add(key);
  if (value.trim() !== '') {
    return line;
  }

  changed = true;
  return `${key}=${requiredSecrets.get(key)()}`;
});

for (const [key, generate] of requiredSecrets) {
  if (!seen.has(key)) {
    changed = true;
    updatedLines.push(`${key}=${generate()}`);
  }
}

if (changed) {
  const output = `${updatedLines.join('\n').replace(/\n*$/, '')}\n`;
  writeFileSync(envPath, output, { mode: 0o600 });
  console.log(`Updated ${envPath}`);
} else {
  console.log(`${envPath} already has Forgejo secrets`);
}
