import type { Command } from 'commander';
import pc from 'picocolors';
import { getConfig } from './config.js';

export interface YankPostResult {
  status: number;
  body: unknown;
}

export interface YankDeps {
  postRegistry: (
    path: string,
    body: unknown,
    token?: string,
  ) => Promise<YankPostResult>;
  token?: string;
}

function parseYankRef(
  ref: string,
): { owner: string; name: string; version: string } | null {
  const atIdx = ref.lastIndexOf('@');
  if (atIdx <= 0) return null;
  const left = ref.slice(0, atIdx);
  const version = ref.slice(atIdx + 1);
  if (!version) return null;
  const slash = left.indexOf('/');
  if (slash <= 0 || slash === left.length - 1) return null;
  const owner = left.slice(0, slash);
  const name = left.slice(slash + 1);
  if (!owner || !name) return null;
  return { owner, name, version };
}

export async function runYank(
  deps: YankDeps,
  ref: string,
  reason: string,
  severity: string = 'high',
): Promise<number> {
  if (!reason) {
    console.error(pc.red('--reason is required'));
    return 1;
  }

  const parsed = parseYankRef(ref);
  if (!parsed) {
    console.error(
      pc.red(`Invalid ref "${ref}". Expected format: owner/name@version`),
    );
    return 1;
  }

  const { owner, name, version } = parsed;
  const path = `/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/yank`;

  let result: YankPostResult;
  try {
    result = await deps.postRegistry(path, { reason, severity }, deps.token);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    return 1;
  }

  if (result.status === 201) {
    console.log(pc.green(`yanked ${ref}`));
    return 0;
  }
  if (result.status === 403) {
    console.error(pc.red('not authorized (compliance only)'));
    return 1;
  }

  const bodyMsg =
    typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body ?? {});
  console.error(pc.red(`yank failed (${result.status}): ${bodyMsg}`));
  return 1;
}

async function postRegistryViaFetch(
  registryUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<YankPostResult> {
  const base = registryUrl.replace(/\/$/, '');
  const url = `${base}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsedBody: unknown;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    parsedBody = text;
  }
  return { status: res.status, body: parsedBody };
}

export function registerYank(program: Command): void {
  program
    .command('yank <ref>')
    .description(
      'Yank a published skill version (compliance only). Ref: owner/name@version',
    )
    .requiredOption('--reason <reason>', 'Reason for yank (required)')
    .option(
      '--severity <severity>',
      'Severity: low|high|critical',
      'high',
    )
    .action(
      async (
        ref: string,
        options: { reason: string; severity: string },
      ) => {
        const config = getConfig();
        if (!config.registry) {
          console.error(
            pc.red('No registry configured. Use: asr config set registry <url>'),
          );
          process.exit(1);
        }
        const registryUrl = config.registry;
        const postRegistry = (
          path: string,
          body: unknown,
          token?: string,
        ): Promise<YankPostResult> =>
          postRegistryViaFetch(registryUrl, path, body, token);
        const code = await runYank(
          { postRegistry, token: config.token },
          ref,
          options.reason,
          options.severity,
        );
        if (code !== 0) process.exit(code);
      },
    );
}
