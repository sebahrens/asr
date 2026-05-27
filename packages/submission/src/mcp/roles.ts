import type { Identity } from '../auth/types.js';
import { MCP_ERROR, McpToolError } from './errors.js';

export function requireToolRole(principal: Identity, required: string): void {
  if (!principal.roles.includes(required)) {
    throw new McpToolError(MCP_ERROR.insufficient_permissions, 'insufficient_permissions', {
      required,
      actual: principal.roles,
    });
  }
}
