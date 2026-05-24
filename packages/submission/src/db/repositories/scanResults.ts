import type { ScanReport } from '@asr/core';
import type Database from 'better-sqlite3';

interface ScanResultRow {
  id: string;
  submission_id: string;
  content_hash: string;
  scanner_image: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  verdict: ScanReport['verdict'];
  findings_json: string;
  tool_results_json: string;
  signature: string | null;
}

export function insertScanResult(db: Database.Database, report: ScanReport): void {
  db.prepare(`
    INSERT INTO scan_results (
      id,
      submission_id,
      content_hash,
      scanner_image,
      started_at,
      completed_at,
      duration_ms,
      verdict,
      finding_count,
      findings_json,
      tool_results_json,
      signature
    ) VALUES (
      @scanId,
      @submissionId,
      @contentHash,
      @scannerImage,
      @startedAt,
      @completedAt,
      @durationMs,
      @verdict,
      @findingCount,
      @findingsJson,
      @toolResultsJson,
      @signature
    )
  `).run({
    ...report,
    findingCount: report.findings.length,
    findingsJson: JSON.stringify(report.findings),
    toolResultsJson: JSON.stringify(report.toolResults),
    signature: report.signature ?? null,
  });
}

export function getScanResult(
  db: Database.Database,
  submissionId: string,
  contentHash: string,
): ScanReport | undefined {
  const row = db
    .prepare(
      `
        SELECT
          id,
          submission_id,
          content_hash,
          scanner_image,
          started_at,
          completed_at,
          duration_ms,
          verdict,
          findings_json,
          tool_results_json,
          signature
        FROM scan_results
        WHERE submission_id = ? AND content_hash = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(submissionId, contentHash) as ScanResultRow | undefined;

  if (!row) {
    return undefined;
  }

  return {
    submissionId: row.submission_id,
    scanId: row.id,
    contentHash: row.content_hash,
    scannerImage: row.scanner_image,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    verdict: row.verdict,
    findings: JSON.parse(row.findings_json) as ScanReport['findings'],
    toolResults: JSON.parse(row.tool_results_json) as ScanReport['toolResults'],
    ...(row.signature ? { signature: row.signature } : {}),
  };
}
