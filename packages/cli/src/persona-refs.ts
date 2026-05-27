export class InvalidManifestError extends Error {
  readonly code = 'invalid_manifest' as const;
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`reference cycle: ${cycle.join(' -> ')}`);
    this.name = 'InvalidManifestError';
    this.cycle = cycle;
  }
}

export function assertNoReferenceCycles(
  root: string,
  getReferences: (name: string) => readonly string[],
): void {
  const path: string[] = [];
  const onPath = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): void => {
    if (onPath.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node];
      throw new InvalidManifestError(cycle);
    }
    if (visited.has(node)) return;
    onPath.add(node);
    path.push(node);
    for (const ref of getReferences(node)) {
      dfs(ref);
    }
    path.pop();
    onPath.delete(node);
    visited.add(node);
  };

  dfs(root);
}
