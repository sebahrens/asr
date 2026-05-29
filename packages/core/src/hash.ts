const CANONICAL_MTIME_SECONDS = 946684800n;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

type HashLike = {
  update(data: Uint8Array): HashLike;
  digest(): Buffer;
  digest(encoding: 'hex'): string;
};

type NodeCryptoLike = {
  createHash(algorithm: 'sha256'): HashLike;
};

function createSha256(): HashLike {
  const getBuiltinModule = (
    globalThis as {
      process?: {
        getBuiltinModule?: (moduleName: 'node:crypto') => NodeCryptoLike;
      };
    }
  ).process?.getBuiltinModule;

  const createHash = getBuiltinModule?.('node:crypto').createHash;
  if (!createHash) {
    throw new Error('canonicalHash requires Node.js crypto support');
  }

  return createHash('sha256');
}

export interface CanonicalFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

export interface CanonicalFileDigest {
  path: string;
  size: number | bigint;
  sha256: Uint8Array;
  executable?: boolean;
}

export function isCanonicalExcluded(path: string): boolean {
  return path
    .split('/')
    .some(
      (segment) =>
        segment === '.DS_Store' ||
        segment === '__MACOSX' ||
        segment === '.git',
    );
}

export function canonicalHash(files: CanonicalFile[]): string {
  return canonicalHashFromDigests(
    files.map((file) => ({
      path: file.path,
      size: file.content.length,
      sha256: createSha256().update(file.content).digest(),
      executable: file.executable,
    })),
  );
}

export function canonicalHashFromDigests(files: CanonicalFileDigest[]): string {
  const includedFiles = files
    .filter((file) => !isCanonicalExcluded(file.path))
    .map((file) => ({
      file,
      pathBytes: Buffer.from(file.path, 'utf8'),
    }))
    .sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));

  const hash = createSha256();

  for (const { file, pathBytes } of includedFiles) {
    const metadata = Buffer.alloc(20);
    metadata.writeUInt32BE(file.executable ? EXECUTABLE_MODE : FILE_MODE, 0);
    metadata.writeBigUInt64BE(CANONICAL_MTIME_SECONDS, 4);
    metadata.writeBigUInt64BE(BigInt(file.size), 12);

    hash.update(pathBytes);
    hash.update(metadata);
    hash.update(file.sha256);
  }

  return hash.digest('hex');
}
