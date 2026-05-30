import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const orchestratorPath = resolve('deploy/docker/scanner/scan-orchestrator.mjs');

test('blocks when gitleaks reports a secret finding', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.scanDir, 'skill.md'), 'AWS key: AKIAIOSFODNN7EXAMPLE\n');

    const result = await runOrchestrator(fixture);

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.verdict, 'block');
    assert.ok(result.report.toolResults.gitleaks.findingCount >= 1);
    assert.equal(result.report.findings[0].severity, 'high');
    assert.match(result.report.signature, /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('allows placeholder and SOPS encrypted secrets through gitleaks config', async () => {
  const fixture = await createFixture();
  try {
    await mkdir(join(fixture.scanDir, 'docs'));
    await writeFile(join(fixture.scanDir, '.env.example'), 'OPENAI_API_KEY=sk-proj-your-placeholder-key\n');
    await writeFile(join(fixture.scanDir, 'README.md'), 'Use FIRECRAWL_API_KEY=fc-your-example-key-here\n');
    await writeFile(join(fixture.scanDir, 'docs', 'setup.md'), 'ANTHROPIC_API_KEY=sk-ant-api03-your-test-key\n');
    await writeFile(
      join(fixture.scanDir, 'secrets.enc.yaml'),
      'api_key: ENC[AES256_GCM,data:sk-proj-real-looking-encrypted-secret,iv:test,tag:test,type:str]\n',
    );

    const result = await runOrchestrator(fixture);

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.verdict, 'pass');
    assert.equal(result.report.toolResults.gitleaks.findingCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('passes against an empty clean directory', async () => {
  const fixture = await createFixture();
  try {
    const result = await runOrchestrator(fixture);

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.verdict, 'pass');
    assert.equal(result.report.findings.length, 0);
    assert.equal(result.report.toolResults.gitleaks.findingCount, 0);
    assert.equal(result.report.toolResults.opengrep.skipped, true);
    assert.equal(result.report.toolResults.veracode.skipped, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('skips opengrep when executable code exists but no rule files are configured', async () => {
  const fixture = await createFixture();
  try {
    const scriptsDir = join(fixture.scanDir, 'scripts');
    const rulesDir = join(fixture.root, 'rules');
    await mkdir(scriptsDir);
    await mkdir(rulesDir);
    await writeFile(join(scriptsDir, 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(rulesDir, '.gitkeep'), '');

    const result = await runOrchestrator(fixture, {
      OPENGREP_RULES_DIR: rulesDir,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.verdict, 'pass');
    assert.equal(result.report.toolResults.opengrep.exitCode, 0);
    assert.equal(result.report.toolResults.opengrep.findingCount, 0);
    assert.equal(result.report.toolResults.opengrep.skipped, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runs opengrep when executable code and rule files are present', async () => {
  const fixture = await createFixture();
  try {
    const scriptsDir = join(fixture.scanDir, 'scripts');
    const rulesDir = join(fixture.root, 'rules');
    await mkdir(scriptsDir);
    await mkdir(rulesDir);
    await writeFile(join(scriptsDir, 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(rulesDir, 'asr.yml'), 'rules: []\n');

    const result = await runOrchestrator(fixture, {
      OPENGREP_RULES_DIR: rulesDir,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.report.verdict, 'pass');
    assert.equal(result.report.toolResults.opengrep.exitCode, 0);
    assert.equal(result.report.toolResults.opengrep.findingCount, 0);
    assert.equal(result.report.toolResults.opengrep.skipped, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('invokes veracode CLI with documented args when credentials are set', async () => {
  const fixture = await createFixture();
  try {
    const recordPath = join(fixture.root, 'veracode-invocation.json');
    await installRecordingVeracode(fixture.binDir, recordPath);

    const result = await runOrchestrator(fixture, {
      VERACODE_API_KEY_ID: 'test-id',
      VERACODE_API_KEY_SECRET: 'test-secret',
      VERACODE_POLICY: 'strict',
    });

    const invocation = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(invocation.argv[0], 'static');
    assert.equal(invocation.argv[1], 'scan');
    assert.equal(invocation.argv[2], fixture.scanDir);
    assert.ok(invocation.argv.includes('--format'));
    assert.ok(invocation.argv.includes('sarif'));
    assert.ok(invocation.argv.includes('--policy'));
    assert.equal(invocation.argv[invocation.argv.indexOf('--policy') + 1], 'strict');
    assert.equal(result.report.toolResults.veracode.skipped, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'asr-scan-'));
  const scanDir = join(root, 'scan');
  const outputDir = join(root, 'output');
  const binDir = join(root, 'bin');

  await mkdir(scanDir);
  await mkdir(outputDir);
  await mkdir(binDir);
  await installMockTools(binDir);

  return { root, scanDir, outputDir, binDir };
}

async function runOrchestrator(fixture, extraEnv = {}) {
  try {
    const { stdout } = await exec(process.execPath, [orchestratorPath], {
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        SCAN_DIR: fixture.scanDir,
        OUTPUT_DIR: fixture.outputDir,
        SUBMISSION_ID: 'sub-test',
        CONTENT_HASH: 'sha256:test',
        SCANNER_IMAGE: 'asr-scanner:test',
        SCAN_SIGNING_KEY: 'test-key',
        GITLEAKS_CONFIG: resolve('deploy/docker/scanner/gitleaks.toml'),
        ...extraEnv,
      },
    });
    return { exitCode: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, report: JSON.parse(error.stdout) };
  }
}

async function installMockTools(binDir) {
  await writeExecutable(
    join(binDir, 'gitleaks'),
    `#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const scanDir = process.argv[3];
const configPath = process.argv[process.argv.indexOf('--config') + 1];
const reportPath = process.argv[process.argv.indexOf('--report-path') + 1];
if (!configPath) {
  throw new Error('missing gitleaks --config');
}

async function scanFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await scanFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function isAllowlisted(path, line) {
  const normalized = path.replace(/\\\\/g, '/');
  const placeholder = /(your|example|sample|placeholder|dummy|fake|test|changeme|replace[_-]?me|xxx|<[^>]+>)/i.test(line);
  if (/(^|\\/)\\.env\\.example$/.test(normalized) && placeholder) return true;
  if (/(^|\\/)README(\\.[^/]*)?$/.test(normalized) && placeholder) return true;
  if (/(^|\\/)(docs|references)\\/.*\\.(md|mdx|txt)$/.test(normalized) && placeholder) return true;
  if (/(^|\\/)secrets\\.enc\\.ya?ml$/.test(normalized) && /ENC\\[/.test(line)) return true;
  return false;
}

const findings = [];
for (const file of await scanFiles(scanDir)) {
  const relativePath = relative(scanDir, file);
  const text = await readFile(file, 'utf8').catch(() => '');
  const lines = text.split(/\\r?\\n/);
  lines.forEach((line, index) => {
    const hasSecret =
      /AKIA[0-9A-Z]{16}/.test(line) ||
      /\\b(sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\\b/.test(line) ||
      /\\bsk-ant-api03-[A-Za-z0-9_-]{20,}\\b/.test(line) ||
      /\\bfc-[A-Za-z0-9_-]{20,}\\b/.test(line);
    if (hasSecret && !isAllowlisted(relativePath, line)) {
      findings.push({
        ruleId: 'mock-secret',
        level: 'error',
        message: { text: 'Secret found' },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: relativePath },
            region: { startLine: index + 1 },
          },
        }],
      });
    }
  });
}

const sarif = {
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'gitleaks', rules: [{ id: 'mock-secret' }] } },
    results: findings,
  }],
};
await writeFile(reportPath, JSON.stringify(sarif));
process.exit(findings.length ? 1 : 0);
`,
  );

  await writeEmptySarifTool(join(binDir, 'trivy'), '--output');
  await writeEmptySarifTool(join(binDir, 'foxguard'), '--output');
  await writeEmptySarifTool(join(binDir, 'opengrep'), '--sarif-output');
}

async function writeEmptySarifTool(path, outputFlag) {
  await writeExecutable(
    path,
    `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const outputPath = process.argv[process.argv.indexOf('${outputFlag}') + 1];
await writeFile(outputPath, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'mock' } }, results: [] }] }));
`,
  );
}

async function installRecordingVeracode(binDir, recordPath) {
  await writeExecutable(
    join(binDir, 'veracode'),
    `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const outputPath = argv[argv.indexOf('--output') + 1];
await writeFile(${JSON.stringify(recordPath)}, JSON.stringify({ argv }));
await writeFile(outputPath, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'veracode' } }, results: [] }] }));
`,
  );
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
