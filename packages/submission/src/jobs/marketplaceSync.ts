import type { MarketplaceManifest, MarketplacePlugin, SkillKind } from '@asr/core';

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
