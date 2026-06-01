import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkNodeVersion,
  formatUnsupportedNodeMessage,
  getNodeMajor,
  isSupportedNodeVersion,
} from './check-node-version.mjs';

describe('check-node-version', () => {
  it('accepts Node 22 releases', () => {
    assert.equal(getNodeMajor('22.22.2'), 22);
    assert.equal(isSupportedNodeVersion('22.22.2'), true);
    assert.deepEqual(checkNodeVersion({ version: '22.22.2', displayVersion: 'v22.22.2', env: {} }), {
      ok: true,
      message: '',
    });
  });

  it('rejects newer Node majors with a clear Node 22 remediation', () => {
    const result = checkNodeVersion({ version: '26.0.0', displayVersion: 'v26.0.0', env: {} });

    assert.equal(result.ok, false);
    assert.match(result.message, /asr requires Node\.js 22 LTS/);
    assert.match(result.message, /Active Node\.js: v26\.0\.0/);
    assert.match(result.message, /nvm use/);
    assert.match(result.message, /pnpm install --frozen-lockfile/);
  });

  it('can be bypassed explicitly while still warning', () => {
    const result = checkNodeVersion({
      version: '26.0.0',
      displayVersion: 'v26.0.0',
      env: { ASR_ALLOW_UNSUPPORTED_NODE: '1' },
    });

    assert.equal(result.ok, true);
    assert.match(result.message, /ASR_ALLOW_UNSUPPORTED_NODE=1/);
  });

  it('formats a standalone unsupported-version message', () => {
    assert.match(formatUnsupportedNodeMessage('v21.7.3'), /Active Node\.js: v21\.7\.3/);
  });
});
