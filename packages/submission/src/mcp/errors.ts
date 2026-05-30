import type { ApiError } from '@asr/core/api-errors';

export const MCP_ERROR = {
  insufficient_permissions: -32001,
  authentication_required: -32002,
  resource_not_found: -32003,
  version_yanked: -32004,
  rate_limited: -32005,
  audit_chain_broken: -32006,
  internal_error: -32099,
} as const;

export type McpErrorCode = (typeof MCP_ERROR)[keyof typeof MCP_ERROR];

export class McpToolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface McpErrorObject {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export function mcpError(
  code: number,
  message: string,
  data?: Record<string, unknown>,
): McpErrorObject {
  if (code === MCP_ERROR.internal_error) {
    return { code, message, data: { traceId: data?.traceId } };
  }
  if (data === undefined) {
    return { code, message };
  }
  return { code, message, data };
}

export function fromApiError(e: ApiError): number {
  switch (e) {
    case 'authentication_required':
      return MCP_ERROR.authentication_required;
    case 'insufficient_permissions':
      return MCP_ERROR.insufficient_permissions;
    case 'skill_not_found':
    case 'submission_not_found':
    case 'version_diff_not_found':
      return MCP_ERROR.resource_not_found;
    case 'version_yanked':
      return MCP_ERROR.version_yanked;
    case 'too_many_requests':
      return MCP_ERROR.rate_limited;
    case 'audit_chain_broken':
      return MCP_ERROR.audit_chain_broken;
    default:
      return MCP_ERROR.internal_error;
  }
}
