import { chmod, writeFile } from 'fs/promises';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatExportLine(token: string): string {
  return `export ASR_TOKEN=${shellSingleQuote(token)}`;
}

export async function writeEnvFile(path: string, token: string): Promise<void> {
  const content = `${formatExportLine(token)}\n`;
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
