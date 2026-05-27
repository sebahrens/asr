import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Submission } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import {
  listSubmissionsBySubmitter,
  rowToSubmission,
} from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const inputShape = {
  limit: z.number().int().min(1).max(100).default(50),
} as const;

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

export function submissionsMineHandler(
  db: Database,
  { limit }: { limit: number },
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { submissions: Submission[] };
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const rows = listSubmissionsBySubmitter(db, principal.sub, limit);
  const submissions = rows.map(rowToSubmission);

  return {
    content: [{ type: 'text', text: JSON.stringify({ submissions }, null, 2) }],
    structuredContent: { submissions },
  };
}

export function registerSubmissionsMine(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'submissions_mine',
    {
      description: 'List your own submissions and their workflow status.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'submissions_mine',
      (args: { limit: number }, extra: unknown) =>
        submissionsMineHandler(db, args, extra),
      deps,
    ),
  );
}
