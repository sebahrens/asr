import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SkillManifest } from '@asr/core';
import type { Identity } from '../../auth/types.js';
import type { Database } from '../../db/index.js';
import { getPublishedSkillVersion } from '../../db/repositories/skills.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { requireToolRole } from '../roles.js';
import { wrapToolHandler, type WrapToolHandlerDeps } from '../server.js';

const inputShape = {
  owner: z.string(),
  name: z.string(),
  version: z.string().optional(),
} as const;

interface RegistryDownloadUrlArgs {
  owner: string;
  name: string;
  version?: string;
}

type RegistryDownloadUrlResult = {
  url: string;
  contentHash: string;
  sizeBytes: number;
  manifest: SkillManifest;
  expiresAt: string;
};

// Forgejo generic package URLs are stable, not signed. expiresAt is nominal
// so MCP clients have a uniform field; pick a far-future constant.
const NOMINAL_EXPIRES_AT = '9999-12-31T23:59:59.000Z';

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

function resolveForgejoBase(): string {
  const raw = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
  return raw.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

export function registryDownloadUrlHandler(
  db: Database,
  args: RegistryDownloadUrlArgs,
  extra: unknown,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: RegistryDownloadUrlResult;
} {
  const principal = principalFromExtra(extra);
  requireToolRole(principal, 'Submitter');

  const resolved = getPublishedSkillVersion(db, args.owner, args.name, args.version);
  if (!resolved) {
    throw new McpToolError(MCP_ERROR.resource_not_found, 'resource_not_found', {
      owner: args.owner,
      name: args.name,
      ...(args.version ? { version: args.version } : {}),
    });
  }

  if (resolved.skillVersion.yanked) {
    throw new McpToolError(MCP_ERROR.version_yanked, 'version_yanked', {
      owner: args.owner,
      name: args.name,
      version: resolved.skillVersion.version,
      ...(resolved.skillVersion.yankReason
        ? { yankReason: resolved.skillVersion.yankReason }
        : {}),
    });
  }

  const base = resolveForgejoBase();
  const result: RegistryDownloadUrlResult = {
    url: `${base}/api/packages/${args.owner}/generic/${args.name}/${resolved.skillVersion.version}/skill.zip`,
    contentHash: resolved.skillVersion.contentHash,
    sizeBytes: 0,
    manifest: resolved.manifest,
    expiresAt: NOMINAL_EXPIRES_AT,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

export function registerRegistryDownloadUrl(
  server: McpServer,
  db: Database,
  deps: WrapToolHandlerDeps,
): void {
  server.registerTool(
    'registry_download_url',
    {
      description:
        'Returns a download URL plus expected content hash for a specific version. ' +
        'The client must download, verify the SHA-256 matches, then extract. Yanked versions return an error.',
      inputSchema: inputShape,
    },
    wrapToolHandler(
      'registry_download_url',
      (args: RegistryDownloadUrlArgs, extra: unknown) =>
        registryDownloadUrlHandler(db, args, extra),
      deps,
    ),
  );
}
