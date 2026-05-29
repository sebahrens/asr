import { describe, expect, it } from 'vitest';

import { isPermissionsExpanded } from './permissions.js';
import type { PermissionsManifest } from './types.js';

function base(overrides: Partial<PermissionsManifest> = {}): PermissionsManifest {
  return {
    network: false,
    subprocess: false,
    filesystem: 'none',
    environment: [],
    ...overrides,
  };
}

describe('isPermissionsExpanded', () => {
  it('returns true when enabling network (false → true)', () => {
    expect(isPermissionsExpanded(base(), base({ network: true }))).toBe(true);
  });

  it('returns true when widening filesystem read-own → read-write-own', () => {
    expect(
      isPermissionsExpanded(
        base({ filesystem: 'read-own' }),
        base({ filesystem: 'read-write-own' }),
      ),
    ).toBe(true);
  });

  it('returns true when adding an environment variable', () => {
    expect(
      isPermissionsExpanded(base({ environment: ['FOO'] }), base({ environment: ['FOO', 'BAR'] })),
    ).toBe(true);
  });

  it('returns true when adding a network host', () => {
    expect(
      isPermissionsExpanded(
        base({ network: true, networkHosts: ['a.example'] }),
        base({ network: true, networkHosts: ['a.example', 'b.example'] }),
      ),
    ).toBe(true);
  });

  it('returns true when enabling subprocess (false → true)', () => {
    expect(isPermissionsExpanded(base(), base({ subprocess: true }))).toBe(true);
  });

  it('returns true when widening filesystem none → read-own', () => {
    expect(
      isPermissionsExpanded(base({ filesystem: 'none' }), base({ filesystem: 'read-own' })),
    ).toBe(true);
  });

  it('returns false when removing a capability (network true → false)', () => {
    expect(isPermissionsExpanded(base({ network: true }), base({ network: false }))).toBe(false);
  });

  it('returns false when narrowing filesystem read-write-own → read-own', () => {
    expect(
      isPermissionsExpanded(
        base({ filesystem: 'read-write-own' }),
        base({ filesystem: 'read-own' }),
      ),
    ).toBe(false);
  });

  it('returns false for identical manifests', () => {
    const p = base({
      network: true,
      networkHosts: ['x.example'],
      filesystem: 'read-own',
      subprocess: false,
      environment: ['TOKEN'],
    });
    expect(isPermissionsExpanded(p, { ...p, networkHosts: [...(p.networkHosts ?? [])] })).toBe(
      false,
    );
  });

  it('returns false when before=null and after grants no capabilities', () => {
    expect(isPermissionsExpanded(null, base())).toBe(false);
  });

  it('returns true when before=null and after grants any capability', () => {
    expect(isPermissionsExpanded(null, base({ network: true }))).toBe(true);
    expect(isPermissionsExpanded(null, base({ subprocess: true }))).toBe(true);
    expect(isPermissionsExpanded(null, base({ filesystem: 'read-own' }))).toBe(true);
    expect(isPermissionsExpanded(null, base({ environment: ['X'] }))).toBe(true);
    expect(isPermissionsExpanded(null, base({ networkHosts: ['x.example'] }))).toBe(true);
  });

  it('returns false when unrestricted network remains unrestricted', () => {
    expect(
      isPermissionsExpanded(base({ network: true }), base({ network: true, networkHosts: [] })),
    ).toBe(false);
  });

  it('returns true when clearing a restricted network host allowlist', () => {
    expect(
      isPermissionsExpanded(
        base({ network: true, networkHosts: ['a.example'] }),
        base({ network: true, networkHosts: [] }),
      ),
    ).toBe(true);
    expect(
      isPermissionsExpanded(
        base({ network: true, networkHosts: ['a.example'] }),
        base({ network: true }),
      ),
    ).toBe(true);
  });

  it('returns false when removing an environment variable', () => {
    expect(
      isPermissionsExpanded(base({ environment: ['FOO', 'BAR'] }), base({ environment: ['FOO'] })),
    ).toBe(false);
  });

  it('returns false when removing a network host', () => {
    expect(
      isPermissionsExpanded(
        base({ network: true, networkHosts: ['a.example', 'b.example'] }),
        base({ network: true, networkHosts: ['a.example'] }),
      ),
    ).toBe(false);
  });
});
