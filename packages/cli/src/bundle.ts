import type { SkillManifest } from '@asr/core';
import { parseSkillManifest } from '@asr/core';
import yauzl from 'yauzl';

const ROOT_SKILL_MD = 'SKILL.md';
const REF_SKILL_MD = /^skills\/([^/]+)\/SKILL\.md$/;
export const BUNDLE_TEXT_LIMITS = {
  maxFiles: 500,
  maxEntryBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
};

export interface BundleEntry {
  manifest: SkillManifest;
  body: string;
}

export interface BundleContents {
  root: BundleEntry | null;
  references: Map<string, BundleEntry>;
}

export async function readBundleContents(buf: Buffer): Promise<BundleContents> {
  const texts = await readZipTextEntries(buf, (name) =>
    name === ROOT_SKILL_MD || REF_SKILL_MD.test(name),
  );

  let root: BundleEntry | null = null;
  const references = new Map<string, BundleEntry>();

  for (const [name, content] of texts) {
    let parsed: BundleEntry;
    try {
      parsed = parseSkillManifest(content);
    } catch {
      continue;
    }
    if (name === ROOT_SKILL_MD) {
      root = parsed;
    } else {
      const match = REF_SKILL_MD.exec(name);
      if (match && match[1]) {
        references.set(match[1], parsed);
      }
    }
  }

  return { root, references };
}

function readZipTextEntries(
  buf: Buffer,
  predicate: (name: string) => boolean,
): Promise<Map<string, string>> {
  return new Promise((resolveAll, rejectAll) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) {
        rejectAll(err);
        return;
      }
      if (!zip) {
        rejectAll(new Error('failed to open zip buffer'));
        return;
      }

      const out = new Map<string, string>();
      let settled = false;
      let matchedFiles = 0;
      let claimedTotalBytes = 0;
      let streamedTotalBytes = 0;

      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        rejectAll(e);
      };

      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (name.endsWith('/') || !predicate(name)) {
          zip.readEntry();
          return;
        }

        matchedFiles += 1;
        if (matchedFiles > BUNDLE_TEXT_LIMITS.maxFiles) {
          fail(new Error(`zip text entry count limit exceeded: ${BUNDLE_TEXT_LIMITS.maxFiles}`));
          return;
        }

        if (entry.uncompressedSize > BUNDLE_TEXT_LIMITS.maxEntryBytes) {
          fail(new Error(`zip text entry too large: ${name}`));
          return;
        }

        claimedTotalBytes += entry.uncompressedSize;
        if (claimedTotalBytes > BUNDLE_TEXT_LIMITS.maxTotalBytes) {
          fail(new Error('zip text total size limit exceeded'));
          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new Error(`failed to read zip entry: ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          let entryBytes = 0;
          stream.on('data', (chunk: Buffer) => {
            entryBytes += chunk.length;
            streamedTotalBytes += chunk.length;
            if (entryBytes > BUNDLE_TEXT_LIMITS.maxEntryBytes) {
              const error = new Error(`zip text entry too large: ${name}`);
              (stream as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(error);
              fail(error);
              return;
            }
            if (streamedTotalBytes > BUNDLE_TEXT_LIMITS.maxTotalBytes) {
              const error = new Error('zip text total size limit exceeded');
              (stream as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(error);
              fail(error);
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (settled) return;
            out.set(name, Buffer.concat(chunks, entryBytes).toString('utf-8'));
            zip.readEntry();
          });
          stream.on('error', fail);
        });
      });

      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolveAll(out);
      });

      zip.on('error', fail);

      zip.readEntry();
    });
  });
}
