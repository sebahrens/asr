import { Buffer } from 'node:buffer';
import type { ForgejoClient, MarketplaceManifest, MarketplacePlugin, SkillKind, SkillManifest } from '@asr/core';

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
  const syncId = new Date().toISOString().replace(/[^0-9TZ]/g, '');
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
  });

  await deps.client.mergePR(pr.prNumber);

  return { prNumber: pr.prNumber, merged: true };
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
