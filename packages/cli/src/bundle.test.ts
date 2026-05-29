import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { BUNDLE_TEXT_LIMITS, readBundleContents } from './bundle.js';

describe('readBundleContents', () => {
  it('reads root and referenced SKILL.md manifests', async () => {
    const buf = await buildZip([
      { path: 'SKILL.md', contents: skillMd('root-skill') },
      { path: 'skills/helper/SKILL.md', contents: skillMd('helper-skill') },
      { path: 'docs/readme.md', contents: '# ignored' },
    ]);

    const bundle = await readBundleContents(buf);

    expect(bundle.root?.manifest.name).toBe('root-skill');
    expect(bundle.references.get('helper')?.manifest.name).toBe('helper-skill');
  });

  it('rejects a matching SKILL.md entry above the per-entry inflated-byte limit', async () => {
    const oversized = `${skillMd('large-skill')}\n${'x'.repeat(BUNDLE_TEXT_LIMITS.maxEntryBytes)}`;
    const buf = await buildZip([{ path: 'SKILL.md', contents: oversized }]);

    await expect(readBundleContents(buf)).rejects.toThrow(/zip text entry too large: SKILL\.md/);
  });

  it('rejects too many matching SKILL.md entries', async () => {
    const entries = Array.from({ length: BUNDLE_TEXT_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: `skills/ref-${i}/SKILL.md`,
      contents: skillMd(`ref-${i}`),
    }));
    const buf = await buildZip(entries);

    await expect(readBundleContents(buf)).rejects.toThrow(/zip text entry count limit exceeded/);
  });

  it('rejects matching SKILL.md entries above the aggregate inflated-byte limit', async () => {
    const bodySize = Math.floor(BUNDLE_TEXT_LIMITS.maxEntryBytes / 2);
    const entryCount = Math.ceil(BUNDLE_TEXT_LIMITS.maxTotalBytes / bodySize) + 1;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      path: `skills/ref-${i}/SKILL.md`,
      contents: `${skillMd(`ref-${i}`)}\n${'x'.repeat(bodySize)}`,
    }));
    const buf = await buildZip(entries);

    await expect(readBundleContents(buf)).rejects.toThrow(/zip text total size limit exceeded/);
  });
});

function skillMd(name: string): string {
  return `---
name: ${name}
version: 1.0.0
author: ASR Team
description: Reviews submissions for security risks.
tags:
  - security
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
---

# ${name}
`;
}

function buildZip(entries: Array<{ path: string; contents: string }>): Promise<Buffer> {
  return new Promise((resolveBuf, rejectBuf) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.contents), entry.path);
    }
    zip.end();

    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolveBuf(Buffer.concat(chunks)));
    zip.outputStream.on('error', rejectBuf);
  });
}
