#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const compose = readFileSync('deploy/docker/docker-compose.yml', 'utf8');
const envExample = readFileSync('deploy/docker/.env.example', 'utf8');

const failures = [];

function requireIncludes(source, expected, label) {
  if (!source.includes(expected)) {
    failures.push(`${label}: missing ${expected}`);
  }
}

requireIncludes(compose, 'FORGEJO__security__INSTALL_LOCK=true', 'docker-compose.yml');
requireIncludes(compose, 'FORGEJO__security__SECRET_KEY=${FORGEJO_SECRET_KEY:?', 'docker-compose.yml');
requireIncludes(compose, 'FORGEJO__security__INTERNAL_TOKEN=${FORGEJO_INTERNAL_TOKEN:?', 'docker-compose.yml');
requireIncludes(
  compose,
  'FORGEJO__security__REVERSE_PROXY_TRUSTED_PROXIES=127.0.0.0/8,::1/128',
  'docker-compose.yml',
);

if (compose.includes('FORGEJO__security__REVERSE_PROXY_TRUSTED_PROXIES=*')) {
  failures.push('docker-compose.yml: Forgejo trusted proxies must not be wildcarded');
}

if (/FORGEJO__security__SECRET_KEY=\s*(?:\n|$)/.test(compose)) {
  failures.push('docker-compose.yml: Forgejo SECRET_KEY must not be empty');
}

requireIncludes(envExample, 'FORGEJO_SECRET_KEY=', '.env.example');
requireIncludes(envExample, 'FORGEJO_INTERNAL_TOKEN=', '.env.example');

if (failures.length > 0) {
  console.error('Docker compose security check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Docker compose security check passed.');
