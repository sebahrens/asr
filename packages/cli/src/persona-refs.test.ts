import { describe, expect, it } from 'vitest';
import { InvalidManifestError, assertNoReferenceCycles } from './persona-refs.js';

function refsOf(graph: Record<string, readonly string[]>) {
  return (name: string): readonly string[] => graph[name] ?? [];
}

describe('assertNoReferenceCycles', () => {
  it('rejects A -> B -> A with invalid_manifest', () => {
    const get = refsOf({ A: ['B'], B: ['A'] });
    let caught: unknown;
    try {
      assertNoReferenceCycles('A', get);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidManifestError);
    expect((caught as InvalidManifestError).code).toBe('invalid_manifest');
    expect((caught as InvalidManifestError).name).toBe('InvalidManifestError');
    expect((caught as InvalidManifestError).message).toContain('A -> B -> A');
  });

  it('accepts A -> B -> C (acyclic)', () => {
    const get = refsOf({ A: ['B'], B: ['C'], C: [] });
    expect(() => assertNoReferenceCycles('A', get)).not.toThrow();
  });

  it('rejects self-reference A -> A as a cycle', () => {
    const get = refsOf({ A: ['A'] });
    expect(() => assertNoReferenceCycles('A', get)).toThrow(InvalidManifestError);
    try {
      assertNoReferenceCycles('A', get);
    } catch (err) {
      expect((err as InvalidManifestError).code).toBe('invalid_manifest');
      expect((err as InvalidManifestError).message).toContain('A -> A');
    }
  });

  it('accepts a node visited twice via diamond (B and C both reach D)', () => {
    const get = refsOf({ A: ['B', 'C'], B: ['D'], C: ['D'], D: [] });
    expect(() => assertNoReferenceCycles('A', get)).not.toThrow();
  });

  it('detects a deeper cycle A -> B -> C -> A', () => {
    const get = refsOf({ A: ['B'], B: ['C'], C: ['A'] });
    try {
      assertNoReferenceCycles('A', get);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidManifestError);
      expect((err as InvalidManifestError).cycle).toEqual(['A', 'B', 'C', 'A']);
    }
  });

  it('returns normally on a root with no references', () => {
    expect(() => assertNoReferenceCycles('A', () => [])).not.toThrow();
  });

  it('only walks reachable nodes (does not flag unreachable cycles)', () => {
    const get = refsOf({ A: ['B'], B: [], X: ['Y'], Y: ['X'] });
    expect(() => assertNoReferenceCycles('A', get)).not.toThrow();
  });
});
