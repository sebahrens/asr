import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { computeVerdict, type ScanReport, type ScanSeverity } from '@asr/core';

export interface RunScannerInput {
  submissionId: string;
  contentHash: string;
  extractedDir: string;
}

export interface RunContainerOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
}

export interface RunContainerResult {
  stdout: string;
  stderr?: string;
}

export type RunContainer = (
  command: string,
  args: string[],
  options: RunContainerOptions,
) => Promise<RunContainerResult>;

const execFileAsync = promisify(execFile);
const timeoutBufferMs = 60_000;
const validSeverities = new Set<ScanSeverity>(['critical', 'high', 'medium', 'low']);

const defaultRunContainer: RunContainer = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout,
      env: options.env,
    });

    return {
      stdout: String(stdout),
      stderr: String(stderr),
    };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    if (String(failed.code) === '1' && failed.stdout) {
      return {
        stdout: String(failed.stdout),
        stderr: failed.stderr ? String(failed.stderr) : undefined,
      };
    }

    throw error;
  }
};

export async function runScanner(
  input: RunScannerInput,
  runContainer: RunContainer = defaultRunContainer,
): Promise<ScanReport> {
  const scannerImage = requiredEnv('SCANNER_IMAGE');
  const timeoutSeconds = parseTimeoutSeconds(
    process.env.SCANNER_TIMEOUT_SECONDS ?? process.env.SCAN_TIMEOUT_SECONDS,
  );
  const severityThreshold = parseSeverityThreshold(
    process.env.SCANNER_SEVERITY_THRESHOLD ?? process.env.SCAN_SEVERITY_THRESHOLD,
  );
  const outputDir = await mkdtemp(join(tmpdir(), `asr-scan-${input.submissionId}-`));

  try {
    const result = await runContainer('docker', buildDockerArgs(input, outputDir, scannerImage), {
      timeout: timeoutSeconds * 1000 + timeoutBufferMs,
      env: buildContainerEnv(input, scannerImage, severityThreshold, timeoutSeconds),
    });

    const report = parseReport(result.stdout);
    assertExpectedVerdict(report, severityThreshold);
    assertSignature(report, process.env.SCAN_SIGNING_KEY);
    return report;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function buildDockerArgs(input: RunScannerInput, outputDir: string, scannerImage: string): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${input.extractedDir}:/scan/input:ro`,
    '-v',
    `${outputDir}:/scan/output`,
    '--env',
    'SUBMISSION_ID',
    '--env',
    'CONTENT_HASH',
    '--env',
    'SCANNER_IMAGE',
    '--env',
    'SCAN_SEVERITY_THRESHOLD',
    '--env',
    'SCAN_TIMEOUT_SECONDS',
    '--env',
    'SCAN_SIGNING_KEY',
    '--env',
    'VERACODE_API_KEY_ID',
    '--env',
    'VERACODE_API_KEY_SECRET',
    scannerImage,
  ];
}

function buildContainerEnv(
  input: RunScannerInput,
  scannerImage: string,
  severityThreshold: ScanSeverity,
  timeoutSeconds: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUBMISSION_ID: input.submissionId,
    CONTENT_HASH: input.contentHash,
    SCANNER_IMAGE: scannerImage,
    SCAN_SEVERITY_THRESHOLD: severityThreshold,
    SCAN_TIMEOUT_SECONDS: String(timeoutSeconds),
    SCAN_SIGNING_KEY: process.env.SCAN_SIGNING_KEY ?? '',
    VERACODE_API_KEY_ID: process.env.VERACODE_API_KEY_ID ?? '',
    VERACODE_API_KEY_SECRET: process.env.VERACODE_API_KEY_SECRET ?? '',
  };
}

function parseReport(stdout: string): ScanReport {
  try {
    return JSON.parse(stdout.trim()) as ScanReport;
  } catch (error) {
    throw new Error(`Scanner did not return valid JSON: ${errorMessage(error)}`);
  }
}

function assertExpectedVerdict(report: ScanReport, severityThreshold: ScanSeverity): void {
  const expectedVerdict = computeVerdict(report.findings, severityThreshold);
  if (expectedVerdict !== report.verdict) {
    throw new Error(
      `Scanner verdict mismatch: expected ${expectedVerdict}, received ${report.verdict}`,
    );
  }
}

function assertSignature(report: ScanReport, signingKey: string | undefined): void {
  if (!signingKey) {
    return;
  }

  if (!report.signature) {
    throw new Error('Scanner report signature is missing');
  }

  const expected = signReport(report, signingKey);
  const actual = Buffer.from(report.signature, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');

  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
    throw new Error('Scanner report signature is invalid');
  }
}

function signReport(report: ScanReport, signingKey: string): string {
  const { signature: _signature, ...unsignedReport } = report;
  return createHmac('sha256', signingKey).update(canonicalJson(unsignedReport)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run scanner`);
  }
  return value;
}

function parseTimeoutSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '300', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('SCANNER_TIMEOUT_SECONDS must be a positive integer');
  }
  return parsed;
}

function parseSeverityThreshold(raw: string | undefined): ScanSeverity {
  const severity = raw ?? 'high';
  if (!validSeverities.has(severity as ScanSeverity)) {
    throw new Error(`SCAN_SEVERITY_THRESHOLD must be one of ${[...validSeverities].join(', ')}`);
  }
  return severity as ScanSeverity;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
