import { describe, expect, it } from 'vitest';
import { SeparationOfDutiesError, assertSeparation } from './separation.js';

describe('assertSeparation', () => {
  it('throws SeparationOfDutiesError when submitter equals approver', () => {
    expect(() => assertSeparation('u1', 'u1')).toThrow(SeparationOfDutiesError);
    expect(() => assertSeparation('u1', 'u1')).toThrow('separation_of_duties_violation');
  });

  it('returns undefined when submitter differs from approver', () => {
    expect(assertSeparation('u1', 'u2')).toBeUndefined();
  });
});

describe('SeparationOfDutiesError', () => {
  it('is a named Error subclass with the canonical message', () => {
    const err = new SeparationOfDutiesError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SeparationOfDutiesError');
    expect(err.message).toBe('separation_of_duties_violation');
  });
});
