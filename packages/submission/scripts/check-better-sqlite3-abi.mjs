import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export function isNativeAddonAbiError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('was compiled against a different Node.js version') ||
    message.includes('invalid ELF header') ||
    message.includes('Module did not self-register')
  );
}

export function formatBetterSqlite3PreflightError(error, versions = process.versions) {
  const message = error instanceof Error ? error.message : String(error);
  const nodeVersion = process.version;
  const moduleVersion = versions.modules ?? 'unknown';

  return [
    'better-sqlite3 is not loadable for the active Node.js runtime.',
    '',
    `Active Node.js: ${nodeVersion} (NODE_MODULE_VERSION ${moduleVersion})`,
    '',
    'Remediation:',
    '  pnpm --filter @asr/submission rebuild better-sqlite3',
    '',
    'If node_modules was produced by a different Node version, run:',
    '  pnpm install --frozen-lockfile',
    '',
    'Project Node version: 22 LTS. Use .nvmrc or .node-version before installing dependencies.',
    '',
    'Original loader error:',
    message,
  ].join('\n');
}

export function checkBetterSqlite3Loadable() {
  require('better-sqlite3');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkBetterSqlite3Loadable();
  } catch (error) {
    const prefix = isNativeAddonAbiError(error)
      ? formatBetterSqlite3PreflightError(error)
      : [
          'Unable to load better-sqlite3 before running the submission tests.',
          '',
          'Run pnpm install --frozen-lockfile from the repository root, then retry.',
          '',
          'Original loader error:',
          error instanceof Error ? error.message : String(error),
        ].join('\n');

    console.error(prefix);
    process.exitCode = 1;
  }
}
