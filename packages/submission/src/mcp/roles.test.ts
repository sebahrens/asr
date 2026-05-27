import { describe, expect, it } from 'vitest';
import { McpToolError } from './errors.js';
import { requireToolRole } from './roles.js';

describe('requireToolRole', () => {
  it('throws McpToolError with -32001 and { required, actual } when principal lacks the required role', () => {
    try {
      requireToolRole({ sub: 'u1', roles: ['Submitter'] }, 'Compliance');
      expect.fail('expected requireToolRole to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolError);
      const e = err as McpToolError;
      expect(e.code).toBe(-32001);
      expect(e.message).toBe('insufficient_permissions');
      expect(e.data).toEqual({ required: 'Compliance', actual: ['Submitter'] });
    }
  });

  it('returns undefined when principal has the required role', () => {
    expect(requireToolRole({ sub: 'u1', roles: ['Compliance'] }, 'Compliance')).toBeUndefined();
  });

  it('matches the required role when principal carries multiple roles', () => {
    expect(
      requireToolRole({ sub: 'u1', roles: ['Submitter', 'Compliance'] }, 'Compliance'),
    ).toBeUndefined();
  });

  it('throws when principal has no roles at all', () => {
    try {
      requireToolRole({ sub: 'u1', roles: [] }, 'Submitter');
      expect.fail('expected requireToolRole to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolError);
      const e = err as McpToolError;
      expect(e.code).toBe(-32001);
      expect(e.data).toEqual({ required: 'Submitter', actual: [] });
    }
  });
});
