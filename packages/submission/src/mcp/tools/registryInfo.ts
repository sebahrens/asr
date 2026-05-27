import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillDetail } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import { getPublishedSkill } from '../../db/repositories/skills.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const inputShape = {
  owner: z.string(),
  name: z.string(),
} as const;

interface RegistryInfoArgs {
  owner: string;
  name: string;
}

function principalFromExtra(extra: unknown): Identity {
  const principal = (
    extra as { authInfo?: { extra?: { principal?: Identity } } } | undefined
  )?.authInfo?.extra?.principal;
  if (!principal) {
    throw new McpToolError(
      MCP_ERROR.authentication_required,
      'authentication_required',
    );
  }
  return principal;
}

export function registryInfoHandler(
  db: Database,
  args: RegistryInfoArgs,
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: SkillDetail;
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const detail = getPublishedSkill(db, args.owner, args.name);
  if (!detail) {
    throw new McpToolError(
      MCP_ERROR.resource_not_found,
      'resource_not_found',
      { owner: args.owner, name: args.name },
    );
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
    structuredContent: detail,
  };
}

export function registerRegistryInfo(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'registry_info',
    {
      description:
        'Return manifest and full version list (yanked entries included but marked) for one published skill.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'registry_info',
      (args: RegistryInfoArgs, extra: unknown) =>
        registryInfoHandler(db, args, extra),
      deps,
    ),
  );
}
