import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { getConfig } from '../config.js';
import { getSkillDetail } from '../registry-client.js';

function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid slug "${slug}". Expected format: owner/name`);
  }
  return { owner: parts[0], name: parts[1] };
}

export async function runVersions(slug: string): Promise<void> {
  let owner: string;
  let name: string;
  try {
    ({ owner, name } = parseSlug(slug));
  } catch (err) {
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }

  const spinner = ora('Fetching versions...').start();
  try {
    const config = getConfig();
    const token = config.token;
    const detail = await getSkillDetail(owner, name, token ? { token } : {});
    spinner.stop();

    if (!detail.versions || detail.versions.length === 0) {
      console.log('No versions found.');
      return;
    }

    const sorted = [...detail.versions].sort((a, b) =>
      b.publishedAt.localeCompare(a.publishedAt)
    );

    for (const v of sorted) {
      const parts: string[] = [`${v.version}  ${v.publishedAt}`];
      if (v.yanked) {
        parts.push(pc.red(`(yanked: ${v.yankReason ?? ''})`));
      }
      if (v.version === detail.latestVersion) {
        parts.push(pc.green('<- latest'));
      }
      console.log(parts.join(' '));
    }
  } catch (err) {
    spinner.fail('Failed to fetch versions');
    console.error(pc.red(String(err)));
    process.exit(1);
  }
}

export function registerVersions(program: Command): void {
  program
    .command('versions <slug>')
    .description('List all versions of a skill, marking yanked and latest (owner/name)')
    .action(async (slug: string) => {
      await runVersions(slug);
    });
}
