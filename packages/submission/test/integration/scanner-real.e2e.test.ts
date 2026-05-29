import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ScanTool } from '@asr/core';
import { runScanner } from '../../src/scan/runScanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(__dirname, '../fixtures/scanning/real');
const shouldRunScannerE2E = process.env.RUN_SCANNER_E2E === '1';

const ALL_TOOLS: ScanTool[] = ['gitleaks', 'trivy', 'foxguard', 'opengrep', 'veracode'];

/**
 * Real, code-bearing skills cloned from public GitHub repos by
 * `scripts/fetch-real-skills.sh`. The corpus is git-ignored, so each case
 * skips when its directory is absent — run the fetch script first to populate.
 *
 * `hasDependencyManifest` flags skills that ship a requirements.txt /
 * package.json, so Trivy has something real to resolve (it must not report
 * itself skipped for those).
 *
 * KNOWN FAILING (acceptance test for asr-cpus): against the current built
 * image these cases fail with "Scanner verdict mismatch" because the
 * orchestrator's verdict ignores tool exit codes while @asr/core fails-closed
 * on them (opengrep errors with an empty rules dir — asr-5z1h; foxguard exits
 * 2 on skipped files — asr-u9ju). The cases turn green once those are fixed.
 * Gated behind RUN_SCANNER_E2E=1, so it does not affect the default suite.
 */
const REAL_SKILLS: Array<{ name: string; hasDependencyManifest: boolean }> = [
  { name: 'webapp-testing', hasDependencyManifest: false },
  { name: 'slack-gif-creator', hasDependencyManifest: true },
  { name: 'pptx', hasDependencyManifest: false },
  { name: 'firecrawl-research', hasDependencyManifest: true },
  { name: 'transcript-analyzer', hasDependencyManifest: true },
  { name: 'transcript-fixer', hasDependencyManifest: true },
];

describe.skipIf(!shouldRunScannerE2E)('scanner container integration — real skills', () => {
  for (const skill of REAL_SKILLS) {
    const skillDir = join(corpusDir, skill.name);

    it.skipIf(!existsSync(skillDir))(
      `produces a consistent, signed report for ${skill.name}`,
      async () => {
        vi.stubEnv('SCANNER_IMAGE', process.env.SCANNER_IMAGE ?? 'asr-scanner:test');
        vi.stubEnv('SCAN_SIGNING_KEY', process.env.SCAN_SIGNING_KEY ?? 'test-signing-key');

        const report = await runScanner({
          submissionId: `sub_real_${skill.name}`,
          contentHash: `sha256:real-${skill.name}`,
          extractedDir: skillDir,
        });

        // runScanner already throws on verdict mismatch / bad signature, so a
        // returned report is internally consistent. Pin down the shape here.
        expect(['pass', 'review_required', 'block']).toContain(report.verdict);
        expect(report.signature).toEqual(expect.any(String));
        expect(report.submissionId).toBe(`sub_real_${skill.name}`);

        // Every tool must report a result, and its findingCount must match the
        // findings actually attributed to it (this is what computeVerdict keys
        // off — a mismatch would have already failed runScanner).
        for (const tool of ALL_TOOLS) {
          const result = report.toolResults[tool];
          expect(result, `missing toolResult for ${tool}`).toBeDefined();
          const actual = report.findings.filter((f) => f.tool === tool).length;
          expect(result.findingCount).toBe(actual);
        }

        // Veracode is enterprise-optional and unconfigured in CI, so it must
        // cleanly skip rather than error.
        expect(report.toolResults.veracode.skipped).toBe(true);

        // Trivy must actually run (not skip) for skills that ship a manifest.
        if (skill.hasDependencyManifest) {
          expect(report.toolResults.trivy.skipped).not.toBe(true);
        }

        // Surface real findings so a manual run shows what the scanners caught.
        const summary = ALL_TOOLS.map((t) => `${t}=${report.toolResults[t].findingCount}`).join(' ');
        // eslint-disable-next-line no-console
        console.log(`[scan:${skill.name}] verdict=${report.verdict} ${summary}`);
      },
      300_000,
    );
  }
});
