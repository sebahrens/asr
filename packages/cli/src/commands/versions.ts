import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { getConfigWithSecrets } from '../config.js';
import { getSkillDetail, RegistryError } from '../registry-client.js';
import { resolveRegistryToken } from '../auth/registry-token.js';

function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid slug "${slug}". Expected format: owner/name`);
  }
  return { owner: parts[0], name: parts[1] };
}

export async function runVersions(slug: string): Promise<number> {
  let owner: string;
  let name: string;
  try {
    ({ owner, name } = parseSlug(slug));
  } catch (err) {
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    return 1;
  }

  const spinner = ora('Fetching versions...').start();
  try {
    const config = await getConfigWithSecrets();
    const token = await resolveRegistryToken({ configToken: config.token });
    const detail = await getSkillDetail(owner, name, token ? { token } : {});
    spinner.stop();

    if (!detail.versions || detail.versions.length === 0) {
      console.log('No versions found.');
      return 0;
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
    return 0;
  } catch (err) {
    spinner.fail('Failed to fetch versions');
    if (err instanceof RegistryError && err.status === 404) {
      console.error(pc.red(`skill not found: ${owner}/${name}`));
    } else {
      console.error(pc.red(String(err)));
    }
    return 1;
  }
}

export function registerVersions(program: Command): void {
  program
    .command('versions <slug>')
    .description('List all versions of a skill, marking yanked and latest (owner/name)')
    .action(async (slug: string) => {
      const code = await runVersions(slug);
      if (code !== 0) process.exit(code);
    });
}
