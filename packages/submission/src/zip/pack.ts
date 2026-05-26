import yazl from 'yazl';

export interface SkillZipFile {
  path: string;
  content: Buffer;
}

const DETERMINISTIC_MTIME = new Date(0);
const DETERMINISTIC_MODE = 0o100644;

export async function packSkillZip(files: SkillZipFile[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const file of sorted) {
    zip.addBuffer(file.content, file.path, {
      mtime: DETERMINISTIC_MTIME,
      mode: DETERMINISTIC_MODE,
    });
  }
  zip.end();

  return collectStream(zip.outputStream);
}

function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
