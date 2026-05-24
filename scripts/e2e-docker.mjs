#!/usr/bin/env node
// Minimal Docker E2E smoke test for the asr dev stack.
//
// Brings up `deploy/docker/docker-compose.yml`, waits for the submission API's
// /health endpoint, then tears the stack down. Richer scenarios (publish flow,
// approval flow, audit verify) land in Phase 1 once the corresponding endpoints
// from specs/api.md and specs/registry-api.md exist.
//
// Run via:  pnpm test:e2e

import { execSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const composeCwd = resolve(repoRoot, 'deploy/docker');
const apiBaseUrl = process.env.ASR_API_URL ?? 'http://localhost:3001';

function pickComposeCommand() {
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return 'docker compose';
  } catch {
    return 'docker-compose';
  }
}

function run(cmd, options = {}) {
  execSync(cmd, { cwd: composeCwd, stdio: 'inherit', ...options });
}

async function waitHealth(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(`${apiBaseUrl}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API health check timed out (${apiBaseUrl}/health)`);
}

async function assertApprovalQueue() {
  const queue = await fetch(`${apiBaseUrl}/api/v1/submissions?status=pending`);
  if (!queue.ok) {
    throw new Error(`approval queue returned ${queue.status}`);
  }

  const data = await queue.json();
  if (!Array.isArray(data.submissions) || data.submissions.length === 0) {
    throw new Error('approval queue did not return seeded submissions');
  }

  const submission = data.submissions.find((item) => item.id === 'sub-1042') ?? data.submissions[0];
  const decision = await fetch(`${apiBaseUrl}/api/v1/submissions/${submission.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  if (!decision.ok) {
    throw new Error(`approval decision returned ${decision.status}`);
  }

  const decisionData = await decision.json();
  if (decisionData.submission?.status !== 'approved') {
    throw new Error('approval decision did not update the submission status');
  }
}

const composeCmd = pickComposeCommand();

console.log(`Starting dev stack via "${composeCmd}" in ${composeCwd}...`);
run(`${composeCmd} down -v`);
run(`${composeCmd} up -d --build`);

try {
  await waitHealth();
  await assertApprovalQueue();
  console.log('E2E smoke check passed: /health and approval queue are OK');
} catch (err) {
  console.error('E2E smoke check FAILED:', err.message);
  console.error('--- recent api logs ---');
  try { run(`${composeCmd} logs --tail=50 api`); } catch {}
  process.exitCode = 1;
} finally {
  console.log('Stopping dev stack...');
  try { run(`${composeCmd} down -v`); } catch {}
}
