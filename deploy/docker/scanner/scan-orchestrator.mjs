#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const SCAN_DIR = process.env.SCAN_DIR || '/scan/input';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/scan/output';
const TIMEOUT = Number.parseInt(process.env.SCAN_TIMEOUT_SECONDS || '300', 10) * 1000;
const SEVERITY_THRESHOLD = (process.env.SCAN_SEVERITY_THRESHOLD || 'high').toLowerCase();
const GITLEAKS_CONFIG = process.env.GITLEAKS_CONFIG || '/opt/scan/gitleaks.toml';
const TRIVY_CONFIG = process.env.TRIVY_CONFIG || '/opt/scan/trivy.yaml';
const TRIVY_IGNOREFILE = process.env.TRIVY_IGNOREFILE || '/opt/scan/.trivyignore';
const FOXGUARD_SEVERITY_THRESHOLD = (
  process.env.FOXGUARD_SEVERITY_THRESHOLD || 'medium'
).toLowerCase();
const FOXGUARD_MIN_CONFIDENCE = process.env.FOXGUARD_MIN_CONFIDENCE || '0.5';
const FOXGUARD_RULES = process.env.FOXGUARD_RULES || '';

const TOOLS = ['gitleaks', 'trivy', 'foxguard', 'opengrep', 'veracode'];

async function runCommand(command, args) {
  try {
    await exec(command, args, { timeout: TIMEOUT });
    return 0;
  } catch (error) {
    return typeof error.code === 'number' ? error.code : 127;
  }
}

async function runCommandWritingStdout(command, args, outputPath) {
  try {
    const { stdout } = await exec(command, args, {
      timeout: TIMEOUT,
      maxBuffer: 50 * 1024 * 1024,
    });
    await writeFile(outputPath, stdout);
    return 0;
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) {
      await writeFile(outputPath, error.stdout);
    }

    return typeof error.code === 'number' ? error.code : 127;
  }
}

async function runGitleaks() {
  const sarifPath = join(OUTPUT_DIR, 'gitleaks.sarif');
  const exitCode = await runCommand('gitleaks', [
    'dir',
    SCAN_DIR,
    '--config',
    GITLEAKS_CONFIG,
    '--report-format',
    'sarif',
    '--report-path',
    sarifPath,
    '--no-banner',
  ]);

  return {
    tool: 'gitleaks',
    exitCode,
    findings: await parseSarif(sarifPath, 'gitleaks', 'high'),
  };
}

async function runTrivy() {
  const sarifPath = join(OUTPUT_DIR, 'trivy.sarif');
  const exitCode = await runCommand('trivy', [
    'fs',
    SCAN_DIR,
    '--config',
    TRIVY_CONFIG,
    '--ignorefile',
    TRIVY_IGNOREFILE,
    '--format',
    'sarif',
    '--output',
    sarifPath,
    '--severity',
    trivySeverityList(SEVERITY_THRESHOLD),
    '--timeout',
    `${TIMEOUT / 1000}s`,
  ]);

  return {
    tool: 'trivy',
    exitCode,
    findings: await parseSarif(sarifPath, 'trivy'),
  };
}

function trivySeverityList(threshold) {
  switch (threshold) {
    case 'critical':
      return 'CRITICAL';
    case 'high':
      return 'CRITICAL,HIGH';
    case 'low':
      return 'CRITICAL,HIGH,MEDIUM,LOW';
    case 'medium':
    default:
      return 'CRITICAL,HIGH,MEDIUM';
  }
}

async function runFoxguard() {
  const sarifPath = join(OUTPUT_DIR, 'foxguard.sarif');
  const args = [
    SCAN_DIR,
    '--format',
    'sarif',
    '--severity',
    FOXGUARD_SEVERITY_THRESHOLD,
    '--min-confidence',
    FOXGUARD_MIN_CONFIDENCE,
  ];

  if (FOXGUARD_RULES) {
    args.push('--rules', FOXGUARD_RULES);
  }

  const exitCode = await runCommandWritingStdout('foxguard', args, sarifPath);
  const findings = await parseSarif(sarifPath, 'foxguard');

  return {
    tool: 'foxguard',
    exitCode: (await isValidSarif(sarifPath)) ? 0 : exitCode,
    findings,
  };
}

async function runOpengrep() {
  const hasScripts = await hasExecutableCode();
  const rulesDir = process.env.OPENGREP_RULES_DIR || '/opt/scan/rules';
  const hasRules = await hasOpengrepRules(rulesDir);
  if (!hasScripts || !hasRules || process.env.OPENGREP_ENABLED === 'false') {
    return { tool: 'opengrep', exitCode: 0, findings: [], skipped: true };
  }

  const sarifPath = join(OUTPUT_DIR, 'opengrep.sarif');
  const exitCode = await runCommand('opengrep', [
    'scan',
    '--sarif-output',
    sarifPath,
    '-f',
    rulesDir,
    SCAN_DIR,
  ]);

  return {
    tool: 'opengrep',
    exitCode,
    findings: await parseSarif(sarifPath, 'opengrep'),
  };
}

async function runVeracode() {
  if (!process.env.VERACODE_API_KEY_ID || !process.env.VERACODE_API_KEY_SECRET) {
    return { tool: 'veracode', exitCode: 0, findings: [], skipped: true };
  }

  const outputPath = join(OUTPUT_DIR, 'veracode.json');
  const exitCode = await runCommand('veracode', [
    'scan',
    '--type',
    'directory',
    '--source',
    SCAN_DIR,
    '--format',
    'json',
    '--output',
    outputPath,
    '--policy',
    process.env.VERACODE_POLICY || 'default',
  ]);

  return {
    tool: 'veracode',
    exitCode,
    findings: await parseVeracodeJson(outputPath),
  };
}

async function hasExecutableCode() {
  const entries = await readdir(join(SCAN_DIR, 'scripts'), { recursive: true }).catch(() => []);
  return entries.some((entry) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|sh)$/.test(String(entry)));
}

async function hasOpengrepRules(rulesDir) {
  const entries = await readdir(rulesDir, { recursive: true }).catch(() => []);
  return entries.some((entry) => /\.(ya?ml|json)$/i.test(String(entry)));
}

async function parseSarif(path, tool, overrideSeverity) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const findings = [];

    for (const run of raw.runs || []) {
      const rulesById = new Map((run.tool?.driver?.rules || []).map((rule) => [rule.id, rule]));

      for (const result of run.results || []) {
        const location = result.locations?.[0]?.physicalLocation;
        const rule = rulesById.get(result.ruleId);
        findings.push({
          tool,
          ruleId: result.ruleId || rule?.id || 'unknown',
          severity: overrideSeverity || mapToolSeverity(tool, result, rule),
          message: result.message?.text || result.message?.markdown || rule?.shortDescription?.text || '',
          file: location?.artifactLocation?.uri || '',
          line: location?.region?.startLine || 0,
          ...(location?.region?.snippet?.text ? { snippet: location.region.snippet.text } : {}),
        });
      }
    }

    return findings;
  } catch {
    return [];
  }
}

async function isValidSarif(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return raw?.version === '2.1.0' && Array.isArray(raw.runs);
  } catch {
    return false;
  }
}

async function parseVeracodeJson(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const records = veracodeRecords(raw);

    return records.map((record) => ({
      tool: 'veracode',
      ruleId: veracodeRuleId(record),
      severity: mapVeracodeSeverity(record),
      message: String(
        record.message ||
          record.description ||
          record.title ||
          record.name ||
          record.finding_details?.title ||
          '',
      ),
      file: String(
        record.file ||
          record.file_path ||
          record.path ||
          record.component_path ||
          record.location?.file ||
          record.source_file ||
          '',
      ),
      line: Number(
        record.line ||
          record.line_number ||
          record.location?.line ||
          record.source_line ||
          0,
      ),
    }));
  } catch {
    return [];
  }
}

function veracodeRecords(raw) {
  if (Array.isArray(raw)) return raw;

  return [
    ...(Array.isArray(raw.results) ? raw.results : []),
    ...(Array.isArray(raw.findings) ? raw.findings : []),
    ...(Array.isArray(raw.vulnerabilities) ? raw.vulnerabilities : []),
    ...(Array.isArray(raw.policy_results?.vulnerabilities)
      ? raw.policy_results.vulnerabilities
      : []),
  ];
}

function veracodeRuleId(record) {
  const cwe = record.cwe || record.cwe_id || record.cweId || record.cwe_name;
  if (typeof cwe === 'object' && cwe?.id) return `CWE-${cwe.id}`;
  if (cwe) return String(cwe).startsWith('CWE-') ? String(cwe) : `CWE-${cwe}`;

  return String(record.rule_id || record.ruleId || record.issue_id || record.id || 'unknown');
}

function mapVeracodeSeverity(record) {
  const severity = String(
    record.severity ||
      record.Severity ||
      record.policy_severity ||
      record.cvss_severity ||
      record.risk ||
      record.severity_name ||
      '',
  ).toLowerCase();

  if (severity === 'very high' || severity === 'very_high' || severity === 'critical') {
    return 'critical';
  }
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  if (severity === 'low') return 'low';

  return 'medium';
}

function mapToolSeverity(tool, result, rule) {
  const rawSeverity =
    result.properties?.severity ||
    result.properties?.Severity ||
    result.properties?.securitySeverity ||
    result.properties?.['security-severity'] ||
    rule?.properties?.severity ||
    rule?.properties?.Severity ||
    rule?.properties?.securitySeverity ||
    rule?.properties?.['security-severity'] ||
    result.level;

  const severity = String(rawSeverity || '').toLowerCase();

  if (tool === 'trivy') {
    if (severity === 'critical') return 'critical';
    if (severity === 'high') return 'high';
    if (severity === 'medium') return 'medium';
    if (severity === 'low') return 'low';
  }

  if (tool === 'foxguard') {
    const numericSecuritySeverity = Number.parseFloat(severity);
    if (Number.isFinite(numericSecuritySeverity)) {
      if (numericSecuritySeverity >= 9) return 'critical';
      if (numericSecuritySeverity >= 7) return 'high';
      if (numericSecuritySeverity >= 4) return 'medium';
      if (numericSecuritySeverity > 0) return 'low';
    }

    if (['critical', 'high', 'medium', 'low'].includes(severity)) return severity;
  }

  if (tool === 'opengrep') {
    const confidence = String(
      result.properties?.confidence || rule?.properties?.confidence || '',
    ).toLowerCase();
    if (result.level === 'error' && confidence === 'high') return 'critical';
    if (result.level === 'error') return 'high';
    if (result.level === 'warning') return 'medium';
    if (result.level === 'note' || result.level === 'info') return 'low';
  }

  if (tool === 'veracode') {
    if (severity === 'very high' || severity === 'very_high') return 'critical';
    if (severity === 'high') return 'high';
    if (severity === 'medium') return 'medium';
    if (severity === 'low') return 'low';
  }

  return mapSarifSeverity(result.level);
}

function mapSarifSeverity(level) {
  switch (level) {
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'note':
      return 'low';
    default:
      return 'medium';
  }
}

function computeVerdict(findings) {
  if (findings.some((finding) => finding.severity === 'critical')) return 'block';
  if (findings.some((finding) => finding.tool === 'gitleaks')) return 'block';

  const hasHigh = findings.some((finding) => finding.severity === 'high');
  if (hasHigh && ['critical', 'high'].includes(SEVERITY_THRESHOLD)) return 'review_required';

  const hasMedium = findings.some((finding) => finding.severity === 'medium');
  if (hasMedium && SEVERITY_THRESHOLD === 'medium') return 'review_required';

  const hasLow = findings.some((finding) => finding.severity === 'low');
  if (hasLow && SEVERITY_THRESHOLD === 'low') return 'review_required';

  return 'pass';
}

function createUlid(date = new Date()) {
  const time = encodeBase32(date.getTime(), 10);
  const entropy = encodeBase32(BigInt(`0x${randomBytes(10).toString('hex')}`), 16);
  return `${time}${entropy}`;
}

function encodeBase32(value, length) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let remaining = BigInt(value);
  let output = '';

  for (let index = 0; index < length; index += 1) {
    output = alphabet[Number(remaining % 32n)] + output;
    remaining /= 32n;
  }

  return output;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function signReport(report) {
  const key = process.env.SCAN_SIGNING_KEY;
  if (!key) return report;

  return {
    ...report,
    signature: createHmac('sha256', key).update(canonicalJson(report)).digest('hex'),
  };
}

function buildToolResults(results) {
  return Object.fromEntries(
    TOOLS.map((tool) => {
      const result = results.find((candidate) => candidate.tool === tool);
      return [
        tool,
        {
          exitCode: result?.exitCode ?? 0,
          findingCount: result?.findings.length ?? 0,
          ...(result?.skipped ? { skipped: true } : {}),
        },
      ];
    }),
  );
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const results = await Promise.all([
    runGitleaks(),
    runTrivy(),
    runFoxguard(),
    runOpengrep(),
    runVeracode(),
  ]);
  const completed = Date.now();
  const findings = results.flatMap((result) => result.findings);

  const report = signReport({
    submissionId: process.env.SUBMISSION_ID || 'unknown',
    scanId: createUlid(new Date(start)),
    contentHash: process.env.CONTENT_HASH || '',
    scannerImage: process.env.SCANNER_IMAGE || 'unknown',
    startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - start,
    verdict: computeVerdict(findings),
    findings,
    toolResults: buildToolResults(results),
  });

  const json = JSON.stringify(report, null, 2);
  await writeFile(join(OUTPUT_DIR, 'report.json'), `${json}\n`);
  console.log(json);
  process.exit(report.verdict === 'block' ? 1 : 0);
}

main().catch((error) => {
  console.error('Scan orchestrator failed:', error);
  process.exit(2);
});
