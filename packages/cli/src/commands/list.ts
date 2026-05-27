import { Command } from 'commander';
import pc from 'picocolors';
import type { InstalledSkill } from '@asr/core';
import { getAllInstalled } from '../lockfile.js';

type AgentTarget = 'cursor' | 'claude' | 'project';
type Scope = 'project' | 'global';

interface ListRow {
  scope: Scope;
  entry: InstalledSkill;
}

function collectRows(scope: Scope, skills: Record<string, InstalledSkill>): ListRow[] {
  return Object.values(skills).map((entry) => ({ scope, entry }));
}

export async function runList(opts: { agent?: string } = {}): Promise<void> {
  const target = (opts.agent as AgentTarget) ?? 'project';

  const [projectSkills, globalSkills] = await Promise.all([
    getAllInstalled(target, false),
    getAllInstalled(target, true),
  ]);

  const rows = [
    ...collectRows('project', projectSkills),
    ...collectRows('global', globalSkills),
  ];

  if (rows.length === 0) {
    console.log('No skills installed.');
    return;
  }

  for (const { scope, entry } of rows) {
    const version = entry.version ? `v${entry.version}` : '-';
    const source = entry.sourceUrl ?? entry.source;
    console.log(`${entry.name}  ${version}  [${scope}]  <- ${pc.dim(source)}`);
  }
}

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List installed skills (project and global scopes)')
    .option('--agent <name>', 'Target agent directory layout (cursor|claude|project)', 'project')
    .action(async (options: { agent?: string }) => {
      await runList({ agent: options.agent });
    });
}
