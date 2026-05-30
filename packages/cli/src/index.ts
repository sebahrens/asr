import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { readdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import {
  generateAgentsMd,
  parseSkillMd,
} from '@asr/core';
import { registerLogin, registerLogout, registerWhoami } from './commands/auth.js';
import { registerSearch } from './commands/search.js';
import { registerInfo } from './commands/info.js';
import { registerVersions } from './commands/versions.js';
import { registerPublish } from './commands/publish.js';
import { registerStatus, registerSubmissions } from './commands/submissions.js';
import { registerToken } from './commands/token.js';
import { registerList } from './commands/list.js';
import {
  getConfigValue,
  getConfigWithSecrets,
  getTargetDir,
  isSecretConfigKey,
  redactConfig,
  setConfig,
} from './config.js';
import { installSkill, removeSkill, updateSkill } from './install.js';
import { registerYank } from './yank.js';
import { searchSkills } from './registry-client.js';
import { resolveRegistryToken } from './auth/registry-token.js';

const program = new Command();

program
  .name('asr')
  .description('Agent Skills Kit - install & manage AI agent skills')
  .version('0.1.0');

registerLogin(program);
registerWhoami(program);
registerLogout(program);
registerSearch(program);
registerInfo(program);
registerVersions(program);
registerPublish(program);
registerStatus(program);
registerSubmissions(program);
registerToken(program);
registerList(program);
registerYank(program);

program
  .command('browse')
  .description('Browse skills from private registry')
  .option('-q, --query <query>', 'Search query')
  .action(async (options) => {
    const secrets = await getConfigWithSecrets();
    if (!secrets.registry && !process.env.ASR_URL) {
      console.log(pc.yellow('No registry configured. Use: asr config set registry <url>'));
      return;
    }

    const spinner = ora('Fetching from registry...').start();
    try {
      const token = await resolveRegistryToken({
        configToken: secrets.token,
        baseUrl: secrets.registry,
      });
      const data = await searchSkills(options.query ?? '', {}, token ? { token } : {});
      spinner.stop();

      if (data.items.length === 0) {
        console.log(pc.yellow('No skills found in registry.'));
        return;
      }

      console.log(pc.bold(`\nSkills in registry:\n`));
      for (const skill of data.items) {
        const downloads = skill.downloadCount ? pc.dim(`downloads ${skill.downloadCount}`) : '';
        console.log(`  ${pc.green(`${skill.owner}/${skill.name}`)} ${downloads}`);
        if (skill.description) {
          console.log(`    ${pc.dim(skill.description)}`);
        }
      }
    } catch (err) {
      spinner.fail('Failed to fetch registry');
      console.error(pc.red(String(err)));
      process.exit(1);
    }
  });

program
  .command('install <slug>')
  .description('Install a skill from the registry (owner/name[@version])')
  .option('-g, --global', 'Install globally (~/.claude or ~/.codex)')
  .option('--agent <name>', 'Target agent (claude|codex|both)')
  .option('-t, --token <token>', 'Registry bearer token override')
  .action(async (slug: string, options: { global?: boolean; agent?: string; token?: string }) => {
    const spinner = ora('Installing skill...').start();
    try {
      const result = await installSkill(slug, {
        global: options.global,
        agent: options.agent as 'claude' | 'codex' | 'both' | undefined,
        token: options.token,
      });
      const targets = result.locations.map((l) => pc.dim(l.dir)).join(', ');
      spinner.succeed(
        `Installed ${pc.green(`${result.owner}/${result.name}@${result.version}`)} → ${targets}`,
      );
      if (result.yanked) {
        console.log(pc.yellow(`⚠ Installed version is yanked.`));
      }
    } catch (err) {
      spinner.fail('Installation failed');
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command('add <source>')
  .description('Install a skill from the registry (alias for install)')
  .option('-g, --global', 'Install globally')
  .option('--agent <name>', 'Target agent (claude|codex|both)')
  .option('-t, --token <token>', 'Registry bearer token override')
  .action(async (source: string, options: { global?: boolean; agent?: string; token?: string }) => {
    const spinner = ora('Installing skill...').start();
    try {
      const result = await installSkill(source, {
        global: options.global,
        agent: options.agent as 'claude' | 'codex' | 'both' | undefined,
        token: options.token,
      });
      const targets = result.locations.map((l) => pc.dim(l.dir)).join(', ');
      spinner.succeed(
        `Installed ${pc.green(`${result.owner}/${result.name}@${result.version}`)} → ${targets}`,
      );
      if (result.yanked) {
        console.log(pc.yellow(`⚠ Installed version is yanked.`));
      }
    } catch (err) {
      spinner.fail('Installation failed');
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command('update [slug]')
  .description('Update installed skills to latest non-yanked version (all or owner/name)')
  .option('-g, --global', 'Update globally installed skills (~/.agent)')
  .option('--agent <name>', 'Target agent (claude|codex|both)')
  .option('-t, --token <token>', 'Registry bearer token override')
  .action(async (slug: string | undefined, options: { global?: boolean; agent?: string; token?: string }) => {
    try {
      const results = await updateSkill(slug, {
        global: options.global,
        agent: options.agent as 'claude' | 'codex' | 'both' | undefined,
        token: options.token,
      });

      if (results.length === 0) {
        console.log(pc.yellow('No skills installed from the registry.'));
      }
    } catch (err) {
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command('read <name>')
  .description('Read and output a skill (for agent consumption)')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-g, --global', 'Read from global installation')
  .action(async (name, options) => {
    try {
      const target = options.agent as 'cursor' | 'claude' | 'project';
      const targetDir = getTargetDir(target, name, options.global);
      const skillMdPath = join(targetDir, 'SKILL.md');

      const content = await readFile(skillMdPath, 'utf-8');
      const skill = parseSkillMd(content);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`SKILL: ${skill.name}`);
      console.log(`BASE_DIR: ${targetDir}`);
      console.log('='.repeat(60));
      console.log(skill.body);
      console.log('='.repeat(60) + '\n');
    } catch {
      console.error(pc.red(`Skill "${name}" not found`));
      process.exit(1);
    }
  });

program
  .command('remove <slug>')
  .description('Remove an installed skill (owner/name)')
  .option('-g, --global', 'Remove from global installation (~/.claude or ~/.codex)')
  .option('--agent <name>', 'Target agent (claude|codex|both)')
  .action(async (slug: string, options: { global?: boolean; agent?: string }) => {
    const spinner = ora(`Removing ${slug}...`).start();
    try {
      const result = await removeSkill(slug, {
        global: options.global,
        agent: options.agent as 'claude' | 'codex' | 'both' | undefined,
      });

      const cleanedDirs = result.locations.filter((l) => l.existed);
      if (cleanedDirs.length === 0 && !result.lockEntryRemoved) {
        spinner.warn(`${result.owner}/${result.name} was not installed`);
        return;
      }

      const scopes =
        cleanedDirs.length > 0
          ? cleanedDirs.map((l) => pc.dim(l.dir)).join(', ')
          : pc.dim('lockfile entry only');
      const lockNote = result.lockEntryRemoved ? pc.dim(' [lockfile entry removed]') : '';
      spinner.succeed(
        `Removed ${pc.green(`${result.owner}/${result.name}`)} from ${scopes}${lockNote}`,
      );
    } catch (err) {
      spinner.fail('Removal failed');
      console.error(pc.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Generate AGENTS.md from installed skills')
  .option('-o, --output <path>', 'Output file path', 'AGENTS.md')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-g, --global', 'Use global skills')
  .action(async (options) => {
    const spinner = ora('Syncing skills...').start();
    try {
      const target = options.agent as 'cursor' | 'claude' | 'project';
      const skillsDir = dirname(getTargetDir(target, 'dummy', options.global));

      let entries: string[] = [];
      try {
        entries = await readdir(skillsDir);
      } catch {
        spinner.fail('No skills directory found');
        return;
      }

      const skills = [];
      for (const entry of entries) {
        const skillMdPath = join(skillsDir, entry, 'SKILL.md');
        try {
          await stat(skillMdPath);
          const content = await readFile(skillMdPath, 'utf-8');
          skills.push(parseSkillMd(content));
        } catch {
          continue;
        }
      }

      if (skills.length === 0) {
        spinner.warn('No skills found to sync');
        return;
      }

      const agentsMd = generateAgentsMd(skills);
      await writeFile(options.output, agentsMd);
      spinner.succeed(`Synced ${skills.length} skills to ${pc.cyan(options.output)}`);
    } catch (err) {
      spinner.fail('Sync failed');
      console.error(pc.red(String(err)));
      process.exit(1);
    }
  });

program
  .command('config <action> [key] [value]')
  .description('Manage configuration (get/set registry, token, githubToken, defaultTarget)')
  .action(async (action, key, value) => {
    if (action === 'get') {
      const config = await getConfigWithSecrets();
      if (key) {
        if (isSecretConfigKey(key)) {
          console.log(config[key] ? '<redacted>' : '');
        } else {
          console.log((await getConfigValue(key as keyof typeof config)) || '');
        }
      } else {
        console.log(JSON.stringify(redactConfig(config), null, 2));
      }
    } else if (action === 'set' && key && value) {
      await setConfig(key as 'registry' | 'token' | 'githubToken' | 'defaultTarget', value);
      const displayedValue = isSecretConfigKey(key) ? '<redacted>' : value;
      console.log(pc.green(`Set ${key} = ${displayedValue}`));
    } else {
      console.log(pc.yellow('Usage: asr config get [key] | set <key> <value>'));
    }
  });

program.parse();
