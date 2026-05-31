#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const protectedPaths = [
  'deploy/docker/data/forgejo/gitea/conf/app.ini',
  'deploy/docker/data/forgejo/ssh/ssh_host_ed25519_key',
  'deploy/docker/data/api/workflow.db',
  'deploy/docker/data/api/workflow.db-wal',
];

const failures = [];

for (const path of protectedPaths) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', path], { stdio: 'ignore' });
  } catch {
    failures.push(path);
  }
}

if (failures.length > 0) {
  console.error('Dev Docker data gitignore check failed:');
  for (const failure of failures) {
    console.error(`- ${failure} is stageable`);
  }
  process.exit(1);
}

console.log(`Dev Docker data gitignore check passed (${protectedPaths.length} paths checked).`);
