import { describe, expect, it } from 'vitest';

import {
  formatBetterSqlite3PreflightError,
  isNativeAddonAbiError,
} from './check-better-sqlite3-abi.mjs';

describe('better-sqlite3 ABI preflight', () => {
  it('recognizes native addon ABI loader failures', () => {
    expect(
      isNativeAddonAbiError(
        new Error(
          'The module was compiled against NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 147.'
        )
      )
    ).toBe(true);
  });

  it('prints the targeted rebuild command and active ABI', () => {
    const output = formatBetterSqlite3PreflightError(new Error('compiled against NODE_MODULE_VERSION 127'), {
      modules: '147',
    });

    expect(output).toContain('pnpm --filter @asr/submission rebuild better-sqlite3');
    expect(output).toContain('NODE_MODULE_VERSION 147');
    expect(output).toContain('Project Node version: 22 LTS');
  });
});
