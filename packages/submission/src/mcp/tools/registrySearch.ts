import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillKind, SkillSummary } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import { listPublishedSkills } from '../../db/repositories/skills.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const inputShape = {
  query: z.string().optional(),
  tag: z.array(z.string()).optional(),
  author: z.string().optional(),
  kind: z.enum(['skill', 'persona']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
} as const;

interface RegistrySearchArgs {
  query?: string;
  tag?: string[];
  author?: string;
  kind?: SkillKind;
  limit: number;
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

export function registrySearchHandler(
  db: Database,
  args: RegistrySearchArgs,
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { skills: SkillSummary[] };
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const { items } = listPublishedSkills(db, {
    q: args.query,
    tags: args.tag,
    owner: args.author,
    kind: args.kind,
    limit: args.limit,
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ skills: items }, null, 2) }],
    structuredContent: { skills: items },
  };
}

export function registerRegistrySearch(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'registry_search',
    {
      description:
        'Search the registry for published skills by keyword, tag, kind, or author.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'registry_search',
      (args: RegistrySearchArgs, extra: unknown) =>
        registrySearchHandler(db, args, extra),
      deps,
    ),
  );
}
