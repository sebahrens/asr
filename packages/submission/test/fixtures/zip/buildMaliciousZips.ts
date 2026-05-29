import { readFile, writeFile } from 'node:fs/promises';
import yazl from 'yazl';

export type MaliciousZipKind =
  | 'pathTraversal'
  | 'maxDepth'
  | 'symlink'
  | 'uncompressedSize'
  | 'misdeclaredUncompressedSize'
  | 'maxFiles'
  | 'maxPathLen'
  | 'illegalChars';

export async function buildMaliciousZip(kind: MaliciousZipKind, zipPath: string): Promise<void> {
  switch (kind) {
    case 'pathTraversal':
      await writeZip(zipPath, [{ path: 'aa/aa/etc/passwd', contents: 'owned' }]);
      await replaceZipPath(zipPath, 'aa/aa/etc/passwd', '../../etc/passwd');
      return;
    case 'maxDepth':
      await writeZip(zipPath, [{ path: 'a/b/c/d/e/f.txt', contents: 'too deep' }]);
      return;
    case 'symlink':
      await writeZip(zipPath, [{ path: 'link-to-skill', contents: 'SKILL.md', mode: 0o120777 }]);
      return;
    case 'uncompressedSize':
      await writeZip(zipPath, [
        { path: 'one.txt', contents: 'x'.repeat(16) },
        { path: 'two.txt', contents: 'y'.repeat(16) },
      ]);
      return;
    case 'misdeclaredUncompressedSize':
      await writeZip(zipPath, [{ path: 'payload.txt', contents: 'x'.repeat(1024) }]);
      await rewriteDeclaredUncompressedSizes(zipPath, 0);
      return;
    case 'maxFiles':
      await writeZip(zipPath, [
        { path: 'one.txt', contents: 'one' },
        { path: 'two.txt', contents: 'two' },
        { path: 'three.txt', contents: 'three' },
      ]);
      return;
    case 'maxPathLen':
      await writeZip(zipPath, [{ path: 'very-long-file-name.md', contents: '# too long' }]);
      return;
    case 'illegalChars':
      await writeZip(zipPath, [{ path: 'safe\u202etxt.md', contents: '# rtl override' }]);
      return;
  }
}

async function rewriteDeclaredUncompressedSizes(zipPath: string, size: number): Promise<void> {
  const zipBuffer = await readFile(zipPath);
  const replacement = Buffer.alloc(4);
  replacement.writeUInt32LE(size, 0);

  for (let offset = 0; offset <= zipBuffer.length - 4; offset += 1) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature === 0x04034b50 && offset + 26 <= zipBuffer.length) {
      replacement.copy(zipBuffer, offset + 22);
      continue;
    }

    if (signature === 0x02014b50 && offset + 28 <= zipBuffer.length) {
      replacement.copy(zipBuffer, offset + 24);
    }
  }

  await writeFile(zipPath, zipBuffer);
}

async function writeZip(
  zipPath: string,
  entries: Array<{ path: string; contents: string; mode?: number }>,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path, { mode: entry.mode });
  }
  zip.end();

  await writeFileFromStream(zip.outputStream, zipPath);
}

async function replaceZipPath(zipPath: string, from: string, to: string): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('zip path replacements must preserve byte length');
  }

  let zipBuffer = await readFile(zipPath);
  const fromBuffer = Buffer.from(from);
  const toBuffer = Buffer.from(to);

  let offset = zipBuffer.indexOf(fromBuffer);
  while (offset !== -1) {
    zipBuffer = Buffer.concat([
      zipBuffer.subarray(0, offset),
      toBuffer,
      zipBuffer.subarray(offset + fromBuffer.length),
    ]);
    offset = zipBuffer.indexOf(fromBuffer, offset + toBuffer.length);
  }

  await writeFile(zipPath, zipBuffer);
}

function writeFileFromStream(stream: NodeJS.ReadableStream, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      void writeFile(zipPath, Buffer.concat(chunks)).then(resolve, reject);
    });
    stream.on('error', reject);
  });
}
