import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { getConfig } from '../config.js';
import { getSkillDetail } from '../registry-client.js';
import { resolveRegistryToken } from '../auth/registry-token.js';

function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid slug "${slug}". Expected format: owner/name`);
  }
  return { owner: parts[0], name: parts[1] };
}

export async function runInfo(slug: string): Promise<void> {
  let owner: string;
  let name: string;
  try {
    ({ owner, name } = parseSlug(slug));
  } catch (err) {
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  }

  const spinner = ora('Fetching skill...').start();
  try {
    const config = getConfig();
    const token = await resolveRegistryToken({ configToken: config.token });
    const detail = await getSkillDetail(owner, name, token ? { token } : {});
    spinner.stop();

    console.log(`${pc.bold(`${detail.owner}/${detail.name}`)}  v${detail.latestVersion}`);
    if (detail.description) console.log(detail.description);
    if (detail.tags && detail.tags.length > 0) {
      console.log(`tags: ${detail.tags.join(', ')}`);
    }
    console.log(`downloads: ${detail.downloadCount}`);
    console.log(`risk: ${detail.riskAssessmentLatest}`);
  } catch (err) {
    spinner.fail('Failed to fetch skill');
    console.error(pc.red(String(err)));
    process.exit(1);
  }
}

export function registerInfo(program: Command): void {
  program
    .command('info <slug>')
    .description('Show detail for a single skill (owner/name)')
    .action(async (slug: string) => {
      await runInfo(slug);
    });
}
