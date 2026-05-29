import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ForgejoClient, MarketplaceManifest, MarketplacePlugin, SkillKind, SkillManifest } from '@asr/core';
import type { EmitAuditInput } from '../audit/emit.js';
import type { Database } from '../db/index.js';
import { withPublishLock } from '../workflow/publishLock.js';

export interface MarketplaceSkillInput {
  name: string;
  version: string;
  description: string;
  kind: SkillKind;
  skillMd: string;
}

export interface MarketplaceFile {
  path: string;
  content: string;
}

export interface MarketplaceFiles {
  manifest: MarketplaceManifest;
  files: MarketplaceFile[];
}

export interface SkillRow extends MarketplaceSkillInput {
  author?: string;
}

export interface SyncMarketplaceRepoDeps {
  client: Pick<ForgejoClient, 'openSubmissionPR' | 'mergePR'>;
  readPublishedSkills: () => Promise<SkillRow[]>;
}

export interface SyncMarketplaceRepoResult {
  prNumber: number;
  merged: boolean;
}

export function buildMarketplaceFiles(skills: MarketplaceSkillInput[]): MarketplaceFiles {
  const plugins: MarketplacePlugin[] = skills.map((skill) => ({
    name: skill.name,
    version: skill.version,
    description: skill.description,
    path: `plugins/${skill.name}`,
    kind: skill.kind,
  }));

  const manifest: MarketplaceManifest = {
    name: 'skill-marketplace',
    version: '1',
    plugins,
  };

  const files = skills.flatMap((skill): MarketplaceFile[] => {
    const pluginManifest = JSON.stringify(
      {
        name: skill.name,
        version: skill.version,
        description: skill.description,
      },
      null,
      2,
    );

    return [
      {
        path: `plugins/${skill.name}/.claude-plugin/plugin.json`,
        content: `${pluginManifest}\n`,
      },
      {
        path: `plugins/${skill.name}/.codex-plugin/plugin.json`,
        content: `${pluginManifest}\n`,
      },
      {
        path: `plugins/${skill.name}/skills/${skill.name}/SKILL.md`,
        content: skill.skillMd,
      },
    ];
  });

  return { manifest, files };
}

export async function syncMarketplaceRepo(
  deps: SyncMarketplaceRepoDeps,
): Promise<SyncMarketplaceRepoResult> {
  const skills = await deps.readPublishedSkills();
  const marketplace = buildMarketplaceFiles(skills);
  const syncId = marketplaceSyncId(skills);
  const pr = await deps.client.openSubmissionPR({
    submissionId: `marketplace-sync-${syncId}`,
    manifest: marketplaceSyncManifest(skills),
    branch: `marketplace-sync/${syncId}`,
    pathPrefix: '',
    title: '[Marketplace] Sync generated skill marketplace',
    body: `Generated marketplace sync for ${skills.length} published skill(s).`,
    labels: ['auto-approve', 'marketplace-sync'],
    files: [
      {
        path: 'marketplace.json',
        content: Buffer.from(`${JSON.stringify(marketplace.manifest, null, 2)}\n`),
      },
      ...marketplace.files.map((file) => ({
        path: file.path,
        content: Buffer.from(file.content),
      })),
    ],
    autoApprove: true,
    idempotent: true,
  });

  await deps.client.mergePR(pr.prNumber);

  return { prNumber: pr.prNumber, merged: true };
}

export interface RunMarketplaceSyncDeps extends SyncMarketplaceRepoDeps {
  emitAudit: (input: EmitAuditInput) => void;
  pager: (skillName: string, error: unknown) => void;
  db?: Database;
  now?: () => number;
}

const PAGE_INTERVAL_MS = 3_600_000;
const lastPagedAt = new Map<string, number>();

/** Visible for tests only. */
export function __resetMarketplaceSyncPagerState(): void {
  lastPagedAt.clear();
}

export async function runMarketplaceSync(
  skillName: string,
  deps: RunMarketplaceSyncDeps,
): Promise<SyncMarketplaceRepoResult> {
  try {
    const result = await runWithMarketplaceLock(deps, () => syncMarketplaceRepo(deps));
    deps.emitAudit({
      action: 'marketplace_sync.succeeded',
      skillName,
      actor: 'system',
      actorType: 'system',
      detail: { skillName, prNumber: result.prNumber },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.emitAudit({
      action: 'marketplace_sync.failed',
      skillName,
      actor: 'system',
      actorType: 'system',
      detail: { skillName, error: message },
    });

    const now = deps.now?.() ?? Date.now();
    const last = lastPagedAt.get(skillName);
    if (last === undefined || now - last >= PAGE_INTERVAL_MS) {
      lastPagedAt.set(skillName, now);
      deps.pager(skillName, error);
    }

    throw error;
  }
}

function marketplaceSyncId(skills: SkillRow[]): string {
  const publishedSet = skills
    .map((skill) => `${skill.name}@${skill.version}`)
    .sort()
    .join('\n');

  return createHash('sha256').update(publishedSet).digest('hex');
}

async function runWithMarketplaceLock<T>(
  deps: RunMarketplaceSyncDeps,
  fn: () => Promise<T>,
): Promise<T> {
  if (!deps.db) {
    return fn();
  }

  return withPublishLock(deps.db, '__marketplace_sync__', fn);
}

function marketplaceSyncManifest(skills: SkillRow[]): SkillManifest {
  return {
    name: 'skill-marketplace',
    version: '1',
    description: 'Generated marketplace repository sync',
    author: 'asr',
    tags: ['marketplace'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
    compatibility: {
      'claude-code': '>=1.0.0',
      codex: '>=1.0.0',
    },
    entrypoint: skills[0]?.name ?? 'marketplace',
  };
}
