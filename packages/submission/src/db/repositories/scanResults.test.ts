import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScanReport } from '@asr/core';
import { runMigrations } from '../migrations/index.js';
import { getScanResult, insertScanResult } from './scanResults.js';

describe('scanResults repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips a ScanReport by submission id and content hash', () => {
    db = new Database(':memory:');
    runMigrations(db);

    const report = sampleReport();
    db.prepare('INSERT INTO submissions (id, content_hash) VALUES (?, ?)').run(
      report.submissionId,
      report.contentHash,
    );

    insertScanResult(db, report);

    expect(getScanResult(db, report.submissionId, report.contentHash)).toEqual(report);
  });

  it('returns undefined when no matching scan result exists', () => {
    db = new Database(':memory:');
    runMigrations(db);

    expect(getScanResult(db, 'sub_missing', 'sha256:missing')).toBeUndefined();
  });
});

function sampleReport(): ScanReport {
  return {
    submissionId: 'sub_01',
    scanId: 'scan_01',
    contentHash: 'sha256:abc123',
    scannerImage: 'asr-scanner:test',
    startedAt: '2026-05-24T10:00:00.000Z',
    completedAt: '2026-05-24T10:00:01.250Z',
    durationMs: 1250,
    verdict: 'block',
    findings: [
      {
        tool: 'gitleaks',
        ruleId: 'generic-api-key',
        severity: 'high',
        file: 'SKILL.md',
        line: 12,
        message: 'Potential secret detected',
        snippet: 'token = "secret"',
      },
    ],
    toolResults: {
      gitleaks: { exitCode: 1, findingCount: 1 },
      trivy: { exitCode: 0, findingCount: 0 },
      foxguard: { exitCode: 0, findingCount: 0 },
      opengrep: { exitCode: 0, findingCount: 0 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
    signature: 'abc123',
  };
}
