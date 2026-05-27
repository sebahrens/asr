import { Command } from 'commander';
import pc from 'picocolors';
import type { FetchLike } from '../auth/device-code.js';
import { mintDerivedToken } from '../api.js';
import { getValidAccessToken } from '../auth/session.js';
import { getApiBaseUrl } from '../env.js';
import { formatExportLine, writeEnvFile } from '../token-export.js';

export interface TokenCommandFlags {
  export?: boolean;
  writeEnv?: string;
  once?: boolean;
}

export interface RunTokenOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  getToken?: (baseUrl: string, opts?: { fetch?: FetchLike }) => Promise<string>;
  mintToken?: (opts?: { fetch?: FetchLike; baseUrl?: string }) => Promise<string>;
  writeEnv?: (path: string, token: string) => Promise<void>;
}

const USAGE =
  'Usage: asr token (--export | --write-env <path> | --once)\n';

function defaultStdout(message: string): void {
  process.stdout.write(message);
}

function defaultStderr(message: string): void {
  process.stderr.write(message);
}

export async function runToken(
  flags: TokenCommandFlags,
  opts: RunTokenOptions = {},
): Promise<void> {
  const stdout = opts.stdout ?? defaultStdout;
  const stderr = opts.stderr ?? defaultStderr;
  const getToken = opts.getToken ?? getValidAccessToken;
  const mintToken = opts.mintToken ?? mintDerivedToken;
  const writeEnv = opts.writeEnv ?? writeEnvFile;

  const selected = [
    flags.export ? 'export' : null,
    flags.writeEnv ? 'write-env' : null,
    flags.once ? 'once' : null,
  ].filter(Boolean);

  if (selected.length !== 1) {
    stderr(USAGE);
    process.exit(64);
    return;
  }

  const baseUrl = opts.baseUrl ?? getApiBaseUrl();

  if (flags.once) {
    const token = await mintToken({ fetch: opts.fetch, baseUrl });
    stdout(`${token}\n`);
    return;
  }

  const token = await getToken(baseUrl, { fetch: opts.fetch });

  if (flags.export) {
    stdout(`${formatExportLine(token)}\n`);
    return;
  }

  if (flags.writeEnv) {
    await writeEnv(flags.writeEnv, token);
    return;
  }
}

export function registerToken(program: Command): void {
  program
    .command('token')
    .description(
      'Export the cached access token (--export | --write-env <path> | --once)',
    )
    .option('--export', 'Print a shell-eval line: export ASR_TOKEN=...')
    .option('--write-env <path>', 'Write a 0600 sourced env file at <path>')
    .option('--once', 'Mint and print a short-lived derived token')
    .action(async (options: TokenCommandFlags) => {
      try {
        await runToken(options);
      } catch (err) {
        process.stderr.write(
          `${pc.red(err instanceof Error ? err.message : String(err))}\n`,
        );
        process.exit(1);
      }
    });
}
