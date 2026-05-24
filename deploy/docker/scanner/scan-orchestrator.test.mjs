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

async function runOrchestrator(fixture) {
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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const scanDir = process.argv[3];
const reportPath = process.argv[process.argv.indexOf('--report-path') + 1];
const text = await readFile(join(scanDir, 'skill.md'), 'utf8').catch(() => '');
const hasSecret = /AKIA[0-9A-Z]{16}/.test(text);
const sarif = {
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'gitleaks', rules: [{ id: 'aws-access-token' }] } },
    results: hasSecret ? [{
      ruleId: 'aws-access-token',
      level: 'error',
      message: { text: 'AWS access token found' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'skill.md' }, region: { startLine: 1 } } }],
    }] : [],
  }],
};
await writeFile(reportPath, JSON.stringify(sarif));
process.exit(hasSecret ? 1 : 0);
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

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
