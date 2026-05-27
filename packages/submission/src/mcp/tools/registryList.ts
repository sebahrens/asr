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
  tag: z.array(z.string()).optional(),
  author: z.string().optional(),
  kind: z.enum(['skill', 'persona']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
} as const;

interface RegistryListArgs {
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

function postFilter(
  items: SkillSummary[],
  filters: { tags?: string[]; author?: string },
): SkillSummary[] {
  return items.filter((item) => {
    if (filters.author && item.owner !== filters.author) {
      return false;
    }
    if (filters.tags && filters.tags.length > 0) {
      const tagSet = new Set(item.tags);
      for (const tag of filters.tags) {
        if (!tagSet.has(tag)) return false;
      }
    }
    return true;
  });
}

export function registryListHandler(
  db: Database,
  args: RegistryListArgs,
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { skills: SkillSummary[] };
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const { items } = listPublishedSkills(db, {
    tag: args.tag?.[0],
    kind: args.kind,
    limit: 100,
  });

  const skills = postFilter(items, {
    tags: args.tag,
    author: args.author,
  }).slice(0, args.limit);

  return {
    content: [{ type: 'text', text: JSON.stringify({ skills }, null, 2) }],
    structuredContent: { skills },
  };
}

export function registerRegistryList(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'registry_list',
    {
      description:
        'List published skills with optional tag, author, and kind filters.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'registry_list',
      (args: RegistryListArgs, extra: unknown) =>
        registryListHandler(db, args, extra),
      deps,
    ),
  );
}
