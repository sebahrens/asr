import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { mkdir, writeFile, readdir, readFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
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
import { getConfig, setConfig, getTargetDir } from './config.js';
import { recordInstall } from './lockfile.js';
import { installSkill, removeSkill, updateSkill } from './install.js';
import { registerYank } from './yank.js';

interface RegistrySkill {
  id?: string;
  owner: string;
  repo: string;
  name: string;
  description?: string;
  tags?: string[];
  stars?: number;
  installs?: number;
  updatedAt?: string;
}

interface RegistrySkillsResponse {
  skills: RegistrySkill[];
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function fetchRegistry<T>(path: string, options: { token?: string } = {}): Promise<T | null> {
  const config = getConfig();
  if (!config.registry) return null;
  
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (options.token || config.token) {
    headers.Authorization = `Bearer ${options.token || config.token}`;
  }
  
  const res = await fetch(`${config.registry}${path}`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function listSkillsInRepo(_repo: string, _token?: string, _skillsPath = 'skills'): Promise<string[]> {
  throw new Error('Direct repository listing is no longer supported. Configure a registry and use asr browse.');
}

async function downloadSkillFiles(
  _repo: string,
  _skillName?: string,
  _skillsPath = 'skills',
  _token?: string
): Promise<Record<string, string>> {
  throw new Error('Direct repository installs are no longer supported. Configure a registry and install by skill name.');
}

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
    const config = getConfig();
    if (!config.registry) {
      console.log(pc.yellow('No registry configured. Use: asr config set registry <url>'));
      return;
    }

    const spinner = ora('Fetching from registry...').start();
    try {
      const query = options.query ? `?q=${encodeURIComponent(options.query)}` : '';
      const data = await fetchRegistry<RegistrySkillsResponse>(`/api/skills${query}`);
      spinner.stop();

      if (!data?.skills?.length) {
        console.log(pc.yellow('No skills found in registry.'));
        return;
      }

      console.log(pc.bold(`\nSkills in registry:\n`));
      for (const skill of data.skills) {
        const stars = skill.stars ? pc.dim(`⭐ ${skill.stars}`) : '';
        const installs = skill.installs ? pc.dim(`📦 ${skill.installs}`) : '';
        console.log(`  ${pc.green(skill.name)} ${stars} ${installs}`);
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

async function installFromRegistry(
  owner: string,
  repo: string,
  skillName: string,
  target: 'cursor' | 'claude' | 'project',
  global: boolean
): Promise<boolean> {
  const config = getConfig();
  if (!config.registry) return false;

  try {
    const headers: HeadersInit = {};
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const res = await fetch(`${config.registry}/api/download/${owner}/${repo}/${skillName}`, { headers });
    if (!res.ok) return false;

    const data = await res.json() as { files: Record<string, string> };
    if (!data.files || Object.keys(data.files).length === 0) return false;

    const targetDir = getTargetDir(target, skillName, global);
    await mkdir(targetDir, { recursive: true });

    for (const [path, content] of Object.entries(data.files)) {
      const fullPath = join(targetDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }

    await recordInstall(target, global, skillName, `registry:${owner}/${repo}/${skillName}`);

    const installRes = await fetch(`${config.registry}/api/skills/${owner}/${repo}/${skillName}/install`, {
      method: 'POST',
      headers,
    });
    
    return true;
  } catch {
    return false;
  }
}

async function installFromGitHub(
  repo: string,
  skillName: string,
  skillsPath: string,
  target: 'cursor' | 'claude' | 'project',
  global: boolean,
  token?: string
): Promise<void> {
  const files = await downloadSkillFiles(repo, skillName, skillsPath, token);
  const targetDir = getTargetDir(target, skillName, global);

  await mkdir(targetDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(targetDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  const skillMdPath = join(targetDir, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const meta = parseSkillMd(content);
    await recordInstall(target, global, skillName, `${repo}/${skillsPath}/${skillName}`, meta.version);
  } catch {
    await recordInstall(target, global, skillName, `${repo}/${skillsPath}/${skillName}`);
  }
}

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
  .description('Install a skill (tries registry first, then GitHub)')
  .option('-g, --global', 'Install globally')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-t, --token <token>', 'GitHub token')
  .option('-p, --path <path>', 'Skills directory path in repo', 'skills')
  .option('--github', 'Force install from GitHub')
  .action(async (source, options) => {
    const spinner = ora('Installing skill...').start();
    try {
      const config = getConfig();
      const githubToken = options.token || config.githubToken;
      const target = options.agent as 'cursor' | 'claude' | 'project';

      const parts = source.split('/');
      let owner: string;
      let repo: string;
      let skillName: string | undefined;

      if (parts.length === 3) {
        owner = parts[0];
        repo = parts[1];
        skillName = parts[2];
      } else if (parts.length === 2) {
        owner = parts[0];
        repo = parts[1];
        skillName = undefined;
      } else if (parts.length === 1) {
        skillName = parts[0];
        owner = '';
        repo = '';
      } else {
        throw new Error('Invalid source format. Use skill-name, owner/repo, or owner/repo/skill');
      }

      if (skillName && !options.github && config.registry) {
        spinner.text = 'Checking registry...';
        
        if (owner && repo) {
          const installed = await installFromRegistry(owner, repo, skillName, target, options.global);
          if (installed) {
            const targetDir = getTargetDir(target, skillName, options.global);
            spinner.succeed(`Installed ${pc.green(skillName)} from registry to ${pc.dim(targetDir)}`);
            return;
          }
        } else {
          const data = await fetchRegistry<RegistrySkillsResponse>(`/api/skills?q=${encodeURIComponent(skillName)}`);
          const skills = data?.skills ?? [];
          if (skills.length > 0) {
            const skill = skills.find((s) => s.name === skillName) ?? skills[0];
            const installed = await installFromRegistry(skill.owner, skill.repo, skill.name, target, options.global);
            if (installed) {
              const targetDir = getTargetDir(target, skill.name, options.global);
              spinner.succeed(`Installed ${pc.green(skill.name)} from registry to ${pc.dim(targetDir)}`);
              return;
            }
          }
        }
        spinner.text = 'Not in registry, trying GitHub...';
      }

      if (!owner || !repo) {
        throw new Error('Skill not found in registry. Use owner/repo/skill format for GitHub.');
      }

      const fullRepo = `${owner}/${repo}`;
      if (skillName) {
        await installFromGitHub(fullRepo, skillName, options.path, target, options.global, githubToken);
        const targetDir = getTargetDir(target, skillName, options.global);
        spinner.succeed(`Installed ${pc.green(skillName)} from GitHub to ${pc.dim(targetDir)}`);
      } else {
        const skills = await listSkillsInRepo(fullRepo, githubToken, options.path);
        if (skills.length === 0) {
          const files = await downloadSkillFiles(fullRepo, undefined, '', githubToken);
          const repoName = fullRepo.split('/').pop()!;
          const targetDir = getTargetDir(target, repoName, options.global);

          await mkdir(targetDir, { recursive: true });
          for (const [path, content] of Object.entries(files)) {
            const fullPath = join(targetDir, path);
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, content);
          }
          await recordInstall(target, options.global, repoName, fullRepo);
          spinner.succeed(`Installed ${pc.green(repoName)} from GitHub to ${pc.dim(targetDir)}`);
        } else {
          spinner.text = `Installing ${skills.length} skills from GitHub...`;
          for (const skill of skills) {
            await installFromGitHub(fullRepo, skill, options.path, target, options.global, githubToken);
            console.log(`  ${pc.green('✓')} ${skill}`);
          }
          spinner.succeed(`Installed ${skills.length} skills from GitHub`);
        }
      }
    } catch (err) {
      spinner.fail('Installation failed');
      console.error(pc.red(String(err)));
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
  .command('unpublish <name>', { hidden: true })
  .description('Remove a skill from private registry')
  .option('-o, --owner <owner>', 'Owner name', 'local')
  .option('-r, --repo <repo>', 'Repo name', 'skills')
  .action(async (name, options) => {
    const config = getConfig();
    if (!config.registry || !config.token) {
      console.log(pc.yellow('Registry and token required'));
      process.exit(1);
    }

    const confirmed = await confirm(`Remove "${name}" from registry?`);
    if (!confirmed) {
      console.log(pc.yellow('Cancelled.'));
      process.exit(0);
    }

    const spinner = ora('Removing from registry...').start();
    try {
      const res = await fetch(`${config.registry}/api/admin/skills/${options.owner}/${options.repo}/${name}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.token}` },
      });

      if (!res.ok) throw new Error('Failed to remove');
      spinner.succeed(`Removed ${pc.green(name)} from registry`);
    } catch (err) {
      spinner.fail('Removal failed');
      console.error(pc.red(String(err)));
      process.exit(1);
    }
  });

program
  .command('config <action> [key] [value]')
  .description('Manage configuration (get/set registry, token, githubToken, defaultTarget)')
  .action(async (action, key, value) => {
    if (action === 'get') {
      const config = getConfig();
      if (key) {
        console.log(config[key as keyof typeof config] || '');
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
    } else if (action === 'set' && key && value) {
      setConfig(key as 'registry' | 'token' | 'githubToken' | 'defaultTarget', value);
      console.log(pc.green(`Set ${key} = ${value}`));
    } else {
      console.log(pc.yellow('Usage: asr config get [key] | set <key> <value>'));
    }
  });

program.parse();
