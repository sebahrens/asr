import { execFileSync } from 'child_process';
import { mkdtemp, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { formatExportLine, writeEnvFile } from '../token-export.js';

function evalAndReadAsrToken(exportLine: string): string {
  const script = `${exportLine}\nprintf '%s' "$ASR_TOKEN"`;
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' });
}

describe('token-export', () => {
  describe('formatExportLine', () => {
    it('produces a shell line that sets ASR_TOKEN to a token with an embedded single quote', () => {
      const token = `a'b`;
      const line = formatExportLine(token);
      expect(evalAndReadAsrToken(line)).toBe(token);
    });

    it('handles a plain token', () => {
      const token = 'plain-token-123';
      const line = formatExportLine(token);
      expect(line).toBe(`export ASR_TOKEN='plain-token-123'`);
      expect(evalAndReadAsrToken(line)).toBe(token);
    });

    it('handles tokens with shell metacharacters', () => {
      const token = `a"b$c\`d;e f|g`;
      const line = formatExportLine(token);
      expect(evalAndReadAsrToken(line)).toBe(token);
    });

    it('handles tokens with multiple single quotes', () => {
      const token = `it's a 'test'`;
      expect(evalAndReadAsrToken(formatExportLine(token))).toBe(token);
    });
  });

  describe('writeEnvFile', () => {
    it('writes the export line to a 0600 file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'asr-token-export-'));
      const path = join(dir, 'env');
      const token = `a'b`;

      await writeEnvFile(path, token);

      const fileStat = await stat(path);
      expect(fileStat.mode & 0o777).toBe(0o600);

      const content = await readFile(path, 'utf8');
      expect(content).toBe(`${formatExportLine(token)}\n`);
    });

    it('overwrites an existing file with 0600 mode', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'asr-token-export-'));
      const path = join(dir, 'env');

      await writeEnvFile(path, 'first');
      await writeEnvFile(path, 'second');

      const fileStat = await stat(path);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const content = await readFile(path, 'utf8');
      expect(content).toBe(`${formatExportLine('second')}\n`);
    });
  });
});
