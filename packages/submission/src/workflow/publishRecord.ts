export interface PublishRecord {
  schema: 1;
  contentHash: string;
  scanReportId: string | null;
  approver: string;
  runId: string;
  publishedAt: string;
}

export interface BuildPublishRecordInput {
  contentHash: string;
  scanReportId: string | null;
  approver: string;
  runId: string;
  publishedAt?: string;
}

export function buildPublishRecord(input: BuildPublishRecordInput): PublishRecord {
  return {
    schema: 1,
    contentHash: input.contentHash,
    scanReportId: input.scanReportId,
    approver: input.approver,
    runId: input.runId,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
  };
}

export function serializePublishRecord(record: PublishRecord): Buffer {
  return Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8');
}
