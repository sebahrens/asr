import { describe, expect, it } from 'vitest';
import {
  buildPublishRecord,
  serializePublishRecord,
  type PublishRecord,
} from './publishRecord.js';

describe('publishRecord', () => {
  it('buildPublishRecord returns a record with the provided fields and schema 1', () => {
    const record = buildPublishRecord({
      contentHash: 'sha256:ab',
      scanReportId: null,
      approver: 'system',
      runId: 'run_1',
      publishedAt: '2026-01-01T00:00:00Z',
    });

    expect(record).toEqual({
      schema: 1,
      contentHash: 'sha256:ab',
      scanReportId: null,
      approver: 'system',
      runId: 'run_1',
      publishedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('buildPublishRecord defaults publishedAt to a fresh ISO timestamp', () => {
    const before = Date.now();
    const record = buildPublishRecord({
      contentHash: 'sha256:cd',
      scanReportId: 'scan_42',
      approver: 'alice@example.com',
      runId: 'run_2',
    });
    const after = Date.now();

    expect(record.schema).toBe(1);
    expect(record.scanReportId).toBe('scan_42');
    expect(record.approver).toBe('alice@example.com');
    const parsedAt = Date.parse(record.publishedAt);
    expect(parsedAt).toBeGreaterThanOrEqual(before);
    expect(parsedAt).toBeLessThanOrEqual(after);
  });

  it('serializePublishRecord round-trips via JSON.parse', () => {
    const record: PublishRecord = buildPublishRecord({
      contentHash: 'sha256:ef',
      scanReportId: null,
      approver: 'system',
      runId: 'run_3',
      publishedAt: '2026-02-15T12:34:56Z',
    });

    const serialized = serializePublishRecord(record);
    const text = serialized.toString('utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(record);
  });
});
