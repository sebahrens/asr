import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runScanner } from '../../src/scan/runScanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../fixtures/scanning');
const shouldRunScannerE2E = process.env.RUN_SCANNER_E2E === '1';

describe.skipIf(!shouldRunScannerE2E)('scanner container integration', () => {
  it('blocks a skill fixture with a planted secret', async () => {
    vi.stubEnv('SCANNER_IMAGE', process.env.SCANNER_IMAGE ?? 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', process.env.SCAN_SIGNING_KEY ?? 'test-signing-key');

    const report = await runScanner({
      submissionId: 'sub_secret_fixture',
      contentHash: 'sha256:secret-fixture',
      extractedDir: join(fixturesDir, 'skill-with-secret'),
    });

    expect(report.verdict).toBe('block');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'gitleaks',
        }),
      ]),
    );
    expect(report.signature).toEqual(expect.any(String));
  });

  it('passes a clean markdown-only skill fixture', async () => {
    vi.stubEnv('SCANNER_IMAGE', process.env.SCANNER_IMAGE ?? 'asr-scanner:test');
    vi.stubEnv('SCAN_SIGNING_KEY', process.env.SCAN_SIGNING_KEY ?? 'test-signing-key');

    const report = await runScanner({
      submissionId: 'sub_clean_fixture',
      contentHash: 'sha256:clean-fixture',
      extractedDir: join(fixturesDir, 'clean-skill'),
    });

    expect(report.verdict).toBe('pass');
    expect(report.findings).toHaveLength(0);
    expect(report.signature).toEqual(expect.any(String));
  });
});
