import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillVersion } from '@asr/core';
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

interface RegistryVersionsArgs {
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

export function registryVersionsHandler(
  db: Database,
  args: RegistryVersionsArgs,
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { versions: SkillVersion[] };
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

  // getPublishedSkill already returns versions in semver-rsort order; just
  // strip yanked entries per spec line 34 ("non-yanked versions").
  const versions = detail.versions.filter((v) => v.yanked !== true);

  return {
    content: [{ type: 'text', text: JSON.stringify({ versions }, null, 2) }],
    structuredContent: { versions },
  };
}

export function registerRegistryVersions(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'registry_versions',
    {
      description:
        'Return all non-yanked published versions of a skill, semver-rsorted (newest first).',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'registry_versions',
      (args: RegistryVersionsArgs, extra: unknown) =>
        registryVersionsHandler(db, args, extra),
      deps,
    ),
  );
}
