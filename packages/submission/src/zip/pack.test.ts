import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { packSkillZip } from './pack.js';

describe('packSkillZip', () => {
  it('round-trips entries in sorted order via yauzl', async () => {
    const skill = Buffer.from('# Skill\n');
    const manifest = Buffer.from('name: test\n');

    const zipped = await packSkillZip([
      { path: 'manifest.yaml', content: manifest },
      { path: 'SKILL.md', content: skill },
    ]);

    const entries = await readZipEntries(zipped);
    expect(entries).toEqual([
      { name: 'SKILL.md', content: skill },
      { name: 'manifest.yaml', content: manifest },
    ]);
  });

  it('produces byte-identical buffers for the same input', async () => {
    const files = [
      { path: 'SKILL.md', content: Buffer.from('# Skill\n') },
      { path: 'manifest.yaml', content: Buffer.from('name: test\n') },
    ];

    const first = await packSkillZip(files);
    const second = await packSkillZip(files);
    expect(first.equals(second)).toBe(true);
  });

  it('produces byte-identical buffers regardless of input order', async () => {
    const skill = { path: 'SKILL.md', content: Buffer.from('# Skill\n') };
    const manifest = { path: 'manifest.yaml', content: Buffer.from('name: test\n') };

    const ordered = await packSkillZip([skill, manifest]);
    const reversed = await packSkillZip([manifest, skill]);
    expect(ordered.equals(reversed)).toBe(true);
  });
});

function readZipEntries(buffer: Buffer): Promise<Array<{ name: string; content: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) {
        reject(err);
        return;
      }
      if (!zip) {
        reject(new Error('failed to open zip from buffer'));
        return;
      }

      const entries: Array<{ name: string; content: Buffer }> = [];

      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(streamErr ?? new Error('no stream'));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push({ name: entry.fileName, content: Buffer.concat(chunks) });
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });

      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
