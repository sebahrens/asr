import { describe, expect, it } from 'vitest';
import { MCP_ERROR, McpToolError, fromApiError, mcpError } from './errors.js';

describe('mcpError', () => {
  it('returns full envelope with arbitrary data for non-internal errors', () => {
    expect(
      mcpError(MCP_ERROR.insufficient_permissions, 'insufficient_permissions', {
        required: 'Compliance',
        actual: ['Submitter'],
      }),
    ).toEqual({
      code: -32001,
      message: 'insufficient_permissions',
      data: { required: 'Compliance', actual: ['Submitter'] },
    });
  });

  it('omits data when none provided for non-internal errors', () => {
    expect(mcpError(MCP_ERROR.authentication_required, 'authentication_required')).toEqual({
      code: -32002,
      message: 'authentication_required',
    });
  });

  it('drops all data keys except traceId for internal_error', () => {
    expect(
      mcpError(MCP_ERROR.internal_error, 'boom', { secret: 'x', traceId: 't1' }).data,
    ).toEqual({ traceId: 't1' });
  });
});

describe('fromApiError', () => {
  it('maps version_yanked to -32004', () => {
    expect(fromApiError('version_yanked')).toBe(-32004);
  });

  it('maps the *_not_found family to resource_not_found', () => {
    expect(fromApiError('skill_not_found')).toBe(MCP_ERROR.resource_not_found);
    expect(fromApiError('submission_not_found')).toBe(MCP_ERROR.resource_not_found);
    expect(fromApiError('version_diff_not_found')).toBe(MCP_ERROR.resource_not_found);
  });

  it('maps auth, rate-limit, and chain-break families to their named codes', () => {
    expect(fromApiError('authentication_required')).toBe(MCP_ERROR.authentication_required);
    expect(fromApiError('insufficient_permissions')).toBe(MCP_ERROR.insufficient_permissions);
    expect(fromApiError('too_many_requests')).toBe(MCP_ERROR.rate_limited);
    expect(fromApiError('audit_chain_broken')).toBe(MCP_ERROR.audit_chain_broken);
  });

  it('falls back to internal_error for unmapped ApiError values', () => {
    expect(fromApiError('invalid_zip')).toBe(MCP_ERROR.internal_error);
    expect(fromApiError('separation_of_duties_violation')).toBe(MCP_ERROR.internal_error);
    expect(fromApiError('content_blocked')).toBe(MCP_ERROR.internal_error);
  });
});

describe('McpToolError', () => {
  it('preserves code, message, and data and extends Error', () => {
    const err = new McpToolError(MCP_ERROR.authentication_required, 'authentication_required', {
      reason: 'missing_bearer',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(-32002);
    expect(err.message).toBe('authentication_required');
    expect(err.data).toEqual({ reason: 'missing_bearer' });
  });
});
