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
