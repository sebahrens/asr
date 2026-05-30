#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', 'packages/web/e2e/*.spec.ts'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const failures = [];
let checked = 0;

for (const file of files) {
  if (!existsSync(file)) {
    continue;
  }

  checked += 1;
  const source = readFileSync(file, 'utf8');

  if (!source.includes('expect(')) {
    failures.push(`${file}: missing expect() assertion`);
  }

  if (source.includes('waitForTimeout')) {
    failures.push(`${file}: waitForTimeout is forbidden in e2e specs`);
  }
}

if (failures.length > 0) {
  console.error('E2E spec lint failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`E2E spec lint passed (${checked} specs checked).`);
