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

function assertDockerDaemon() {
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    console.error('E2E smoke check SKIPPED: Docker daemon is not reachable.');
    console.error('Start Docker Desktop (or your Docker engine) and re-run: pnpm test:e2e');
    process.exit(1);
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

async function assertSubmissionCreate() {
  const body = new FormData();
  body.set('owner', 'e2e');
  body.set('skillMd', `---
name: e2e-skill
version: 0.1.0
author: e2e
description: Created by the Docker smoke test.
kind: skill
---

# e2e-skill
`);
  body.set('archive', new Blob(['dev smoke archive']), 'skill.zip');

  const created = await fetch(`${apiBaseUrl}/api/v1/submissions`, {
    method: 'POST',
    body,
  });

  if (created.status !== 201) {
    throw new Error(`submission create returned ${created.status}`);
  }

  const data = await created.json();
  if (!data.id || data.status?.phase !== 'uploaded' || data.manifest?.name !== 'e2e-skill') {
    throw new Error('submission create did not return the expected uploaded response');
  }

  const queue = await fetch(`${apiBaseUrl}/api/v1/submissions?status=pending`);
  const queueData = await queue.json();
  if (!Array.isArray(queueData.submissions) || !queueData.submissions.some((item) => item.id === data.id)) {
    throw new Error('created submission was not added to the pending queue');
  }
}

async function assertRegistryBrowse() {
  const registry = await fetch(`${apiBaseUrl}/api/v1/skills?q=security`);
  if (!registry.ok) {
    throw new Error(`registry browse returned ${registry.status}`);
  }

  const data = await registry.json();
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('registry browse did not return seeded skills');
  }

  const skill = data.items.find((item) => item.owner === 'asr' && item.name === 'security-review');
  if (!skill) {
    throw new Error('registry browse did not return the seeded security-review skill');
  }

  const detail = await fetch(`${apiBaseUrl}/api/v1/skills/${skill.owner}/${skill.name}`);
  if (!detail.ok) {
    throw new Error(`registry detail returned ${detail.status}`);
  }

  const detailData = await detail.json();
  if (detailData.skillMd?.includes('# security-review') !== true) {
    throw new Error('registry detail did not return markdown skill content');
  }

  if (!detailData.skillMd.includes('| Check | Evidence |') || !detailData.skillMd.includes('```text')) {
    throw new Error('registry detail markdown does not include GFM table and fenced code content');
  }
}

const composeCmd = pickComposeCommand();
assertDockerDaemon();

console.log(`Starting dev stack via "${composeCmd}" in ${composeCwd}...`);
run(`${composeCmd} down -v`);
run(`${composeCmd} up -d --build`);

let failureReason = null;
try {
  await waitHealth();
  await assertRegistryBrowse();
  await assertSubmissionCreate();
  await assertApprovalQueue();
  console.log('E2E smoke check passed: /health, registry browse, submission create, and approval queue are OK');
} catch (err) {
  failureReason = err.message;
  console.error('E2E smoke check FAILED:', err.message);
  console.error('--- recent api logs ---');
  try { run(`${composeCmd} logs --tail=50 api`); } catch {}
} finally {
  console.log('Stopping dev stack...');
  try { run(`${composeCmd} down -v`); } catch {}
  if (failureReason) {
    // Print the failure reason as the LAST line so a small `tail -N` window in
    // an outer harness (e.g. ralph-scripts/loop.sh) captures actionable signal
    // instead of the docker compose down output, which would otherwise push the
    // real cause out of the tail window.
    console.error(`=== E2E FAILED: ${failureReason} ===`);
    process.exitCode = 1;
  }
}
