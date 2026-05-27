import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { isValidVersion, type SkillClassification } from '@asr/core';
import type { FetchLike } from '../auth/device-code.js';
import { ApiError, apiFetch, postSubmission, type PostSubmissionResponse } from '../api.js';
import { classifySkill } from '../publish/classify.js';
import { packSkillDir } from '../publish/pack.js';

type SubmissionStatusPhase =
  | 'uploaded'
  | 'classifying'
  | 'pushing-to-forgejo'
  | 'auto-approved'
  | 'questionnaire-pending'
  | 'scanning'
  | 'scan-complete'
  | 'user-confirmation-pending'
  | 'compliance-review'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'withdrawn';

interface SubmissionView {
  id: string;
  status: { phase: SubmissionStatusPhase } & Record<string, unknown>;
}

const TERMINAL_PHASES: ReadonlySet<SubmissionStatusPhase> = new Set([
  'published',
  'rejected',
  'withdrawn',
]);

export interface PublishOptions {
  watch?: boolean;
  fetch?: FetchLike;
  baseUrl?: string;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

interface ManifestSummary {
  name: string;
  version: string;
}

function parseManifestRequiredFields(yaml: string): { name?: string; version?: string } {
  const out: { name?: string; version?: string } = {};
  const lines = yaml.split(/\r?\n/);
  for (const raw of lines) {
    const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (key !== 'name' && key !== 'version') continue;
    let value = (match[2] ?? '').trim();
    if (value.startsWith('#') || value === '') continue;
    const hashIdx = findUnquotedHash(value);
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function findUnquotedHash(value: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return i;
  }
  return -1;
}

async function loadManifest(dir: string): Promise<ManifestSummary> {
  const manifestPath = join(dir, 'manifest.yaml');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read manifest.yaml at ${manifestPath}: ${msg}`);
  }

  const { name, version } = parseManifestRequiredFields(raw);
  if (!name) {
    throw new Error('manifest.yaml is missing required field: name');
  }
  if (!version) {
    throw new Error('manifest.yaml is missing required field: version');
  }
  if (!isValidVersion(version)) {
    throw new Error(`manifest.yaml version "${version}" is not a valid semver`);
  }
  return { name, version };
}

function describePath(classification: SkillClassification): string {
  return classification === 'md-only'
    ? 'auto-approve (md-only)'
    : 'questionnaire + scan + compliance review (code-containing)';
}

const DEFAULT_POLL_INTERVAL_MS = 3000;

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((res) => setTimeout(res, ms));
}

async function watchSubmission(
  id: string,
  initialPhase: SubmissionStatusPhase,
  options: PublishOptions,
): Promise<SubmissionStatusPhase> {
  const log = options.log ?? ((m: string) => console.log(m));
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let lastPhase: SubmissionStatusPhase = initialPhase;

  if (TERMINAL_PHASES.has(lastPhase)) {
    return lastPhase;
  }

  while (true) {
    await sleep(interval);

    let view: SubmissionView;
    try {
      view = await apiFetch<SubmissionView>(`/api/v1/submissions/${encodeURIComponent(id)}`, {
        fetch: options.fetch,
        baseUrl: options.baseUrl,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error(`Submission ${id} not found`);
      }
      throw err;
    }

    const phase = view.status?.phase;
    if (phase && phase !== lastPhase) {
      log(`${pc.cyan('→')} ${phase}`);
      lastPhase = phase;
    }
    if (phase && TERMINAL_PHASES.has(phase)) {
      return phase;
    }
  }
}

export async function runPublish(
  dirArg: string | undefined,
  options: PublishOptions = {},
): Promise<void> {
  const log = options.log ?? ((m: string) => console.log(m));
  const errorLog = options.errorLog ?? ((m: string) => console.error(m));
  const dir = resolve(dirArg ?? '.');

  let manifest: ManifestSummary;
  try {
    manifest = await loadManifest(dir);
  } catch (err) {
    errorLog(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const { buffer, files } = await packSkillDir(dir);
  const classification = classifySkill(files);
  log(`${pc.dim('predicted path:')} ${describePath(classification)}`);

  let response: PostSubmissionResponse;
  try {
    response = await postSubmission(buffer, `${manifest.name}-${manifest.version}.zip`, {
      fetch: options.fetch,
      baseUrl: options.baseUrl,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      errorLog(pc.red(`Submission rejected (${err.status}): ${err.body.error ?? err.message}`));
    } else {
      errorLog(pc.red(err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }

  log(JSON.stringify({ id: response.id, status: response.status }));

  if (options.watch) {
    const terminal = await watchSubmission(response.id, response.status.phase, options);
    log(`${pc.bold('terminal phase:')} ${terminal}`);
  }
}

export function registerPublish(program: Command): void {
  program
    .command('publish [dir]')
    .description('Submit a skill directory to the registry')
    .option('--watch', 'Stream status transitions until terminal phase')
    .action(async (dir: string | undefined, opts: { watch?: boolean }) => {
      await runPublish(dir, { watch: opts.watch });
    });
}
