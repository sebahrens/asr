import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { getConfigWithSecrets } from '../config.js';
import { searchSkills } from '../registry-client.js';
import { resolveRegistryToken } from '../auth/registry-token.js';

export async function runSearch(query: string): Promise<void> {
  const spinner = ora('Searching skills...').start();
  try {
    const config = await getConfigWithSecrets();
    const token = await resolveRegistryToken({ configToken: config.token });
    const { items } = await searchSkills(query, {}, token ? { token } : {});
    spinner.stop();

    if (items.length === 0) {
      console.log('No skills found.');
      return;
    }

    for (const skill of items) {
      console.log(
        `${skill.owner}/${skill.name}  v${skill.latestVersion}  (downloads ${skill.downloadCount})`
      );
      if (skill.description) {
        console.log(`  ${pc.dim(skill.description)}`);
      }
    }
  } catch (err) {
    spinner.fail('Search failed');
    console.error(pc.red(String(err)));
    process.exit(1);
  }
}

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Search for skills in the configured registry')
    .action(async (query: string) => {
      await runSearch(query);
    });
}
