#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const REQUIRED_NODE_MAJOR = 22;

export function getNodeMajor(version = process.versions.node) {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

export function isSupportedNodeVersion(version = process.versions.node) {
  return getNodeMajor(version) === REQUIRED_NODE_MAJOR;
}

export function formatUnsupportedNodeMessage(version = process.version) {
  return [
    `asr requires Node.js ${REQUIRED_NODE_MAJOR} LTS.`,
    '',
    `Active Node.js: ${version}`,
    '',
    'Use the repository version files before installing or running tests:',
    '  nvm use',
    '  # or another version manager that reads .node-version',
    '',
    'Then reinstall native dependencies:',
    '  pnpm install --frozen-lockfile',
    '',
    'Node versions outside 22 can produce misleading failures, including',
    'better-sqlite3 NODE_MODULE_VERSION errors and jsdom storage mismatches.',
  ].join('\n');
}

export function checkNodeVersion({
  version = process.versions.node,
  displayVersion = process.version,
  env = process.env,
} = {}) {
  if (isSupportedNodeVersion(version)) {
    return { ok: true, message: '' };
  }

  const message = formatUnsupportedNodeMessage(displayVersion);
  if (env.ASR_ALLOW_UNSUPPORTED_NODE === '1') {
    return {
      ok: true,
      message: `${message}\n\nContinuing because ASR_ALLOW_UNSUPPORTED_NODE=1 is set.`,
    };
  }

  return { ok: false, message };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkNodeVersion();
  if (result.message) {
    console.error(result.message);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}
