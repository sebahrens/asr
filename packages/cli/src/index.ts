import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { mkdir, writeFile, readdir, rm, readFile, stat } from 'fs/promises';
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
import { getConfig, setConfig, getTargetDir } from './config.js';
import { recordInstall, removeFromLock, getAllInstalled } from './lockfile.js';
import { installSkill } from './install.js';

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

function getRegistryAuthOrExit(overrideToken?: string): { registry: string; token: string } {
  const config = getConfig();
  const token = overrideToken || config.token;
  if (!config.registry) {
    console.log(pc.yellow('No registry configured. Use: asr config set registry <url>'));
    process.exit(1);
  }
  if (!token) {
    console.log(pc.yellow('No token configured. Use: asr config set token <token>'));
    process.exit(1);
  }
  return { registry: config.registry, token };
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

program
  .command('list [repo]')
  .description('List skills in a GitHub repo, or list installed skills')
  .option('-t, --token <token>', 'GitHub token')
  .option('-p, --path <path>', 'Skills directory path', 'skills')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-g, --global', 'Use global skills')
  .action(async (repo, options) => {
    const target = options.agent as 'cursor' | 'claude' | 'project';

    if (!repo) {
      const installed = await getAllInstalled(target, options.global);
      const names = Object.keys(installed);
      
      if (names.length === 0) {
        console.log(pc.yellow('No skills installed.'));
        return;
      }

      console.log(pc.bold(`\nInstalled skills:\n`));
      for (const name of names) {
        const info = installed[name];
        const version = info.version ? pc.dim(`v${info.version}`) : '';
        const source = pc.dim(`← ${info.source}`);
        console.log(`  ${pc.green(name)} ${version} ${source}`);
      }
      return;
    }

    const spinner = ora('Fetching skills...').start();
    try {
      const config = getConfig();
      const skills = await listSkillsInRepo(repo, options.token || config.githubToken, options.path);
      spinner.stop();

      if (skills.length === 0) {
        console.log(pc.yellow('No skills found in this repo.'));
        return;
      }

      console.log(pc.bold(`\nSkills in ${pc.cyan(repo)}:\n`));
      for (const skill of skills) {
        console.log(`  - ${pc.green(skill)}`);
      }
      console.log(pc.dim(`\nUse ${pc.cyan(`asr add ${repo}/<skill>`)} to install`));
    } catch (err) {
      spinner.fail('Failed to list skills');
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
  .command('update [name]')
  .description('Update installed skills (all or specific)')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-g, --global', 'Use global skills')
  .option('-t, --token <token>', 'GitHub token')
  .action(async (name, options) => {
    const spinner = ora('Updating skills...').start();
    try {
      const config = getConfig();
      const githubToken = options.token || config.githubToken;
      const target = options.agent as 'cursor' | 'claude' | 'project';
      const installed = await getAllInstalled(target, options.global);

      const toUpdate = name ? [name] : Object.keys(installed);
      
      if (toUpdate.length === 0) {
        spinner.warn('No skills to update');
        return;
      }

      let updated = 0;
      for (const skillName of toUpdate) {
        const info = installed[skillName];
        if (!info) {
          console.log(`  ${pc.yellow('⚠')} ${skillName} not found in lockfile`);
          continue;
        }

        spinner.text = `Updating ${skillName}...`;

        if (info.source.startsWith('registry:')) {
          const parts = info.source.replace('registry:', '').split('/');
          if (parts.length >= 3) {
            await installFromRegistry(parts[0], parts[1], parts[2], target, options.global);
            console.log(`  ${pc.green('✓')} ${skillName}`);
            updated++;
            continue;
          }
        }

        const sourceParts = info.source.split('/');
        if (sourceParts.length < 3) {
          console.log(`  ${pc.yellow('⚠')} ${skillName} has invalid source: ${info.source}`);
          continue;
        }

        const repo = `${sourceParts[0]}/${sourceParts[1]}`;
        const skillsPath = sourceParts.slice(2, -1).join('/') || 'skills';
        
        await installFromGitHub(repo, skillName, skillsPath, target, options.global, githubToken);
        console.log(`  ${pc.green('✓')} ${skillName}`);
        updated++;
      }

      spinner.succeed(`Updated ${updated} skill(s)`);
    } catch (err) {
      spinner.fail('Update failed');
      console.error(pc.red(String(err)));
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
  .command('remove <name>')
  .description('Remove an installed skill')
  .option('--agent <name>', 'Target agent (cursor/claude/project)', 'project')
  .option('-g, --global', 'Remove from global installation')
  .action(async (name, options) => {
    const spinner = ora(`Removing ${name}...`).start();
    try {
      const target = options.agent as 'cursor' | 'claude' | 'project';
      const targetDir = getTargetDir(target, name, options.global);
      await rm(targetDir, { recursive: true, force: true });
      await removeFromLock(target, options.global, name);
      spinner.succeed(`Removed ${pc.green(name)}`);
    } catch (err) {
      spinner.fail('Removal failed');
      console.error(pc.red(String(err)));
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
  .command('publish <path>', { hidden: true })
  .description('Publish a local skill to private registry')
  .action(async (source) => {
    const config = getConfig();
    if (!config.registry) {
      console.log(pc.yellow('No registry configured. Use: asr config set registry <url>'));
      process.exit(1);
    }
    if (!config.token) {
      console.log(pc.yellow('No token configured. Use: asr config set token <token>'));
      process.exit(1);
    }

    const skillMdPath = source.endsWith('SKILL.md') ? source : join(source, 'SKILL.md');
    const content = await readFile(skillMdPath, 'utf-8');
    const pathParts = source.split('/');
    const skillName = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
    const meta = parseSkillMd(content);
    const displayName = meta.name || skillName;

    const confirmed = await confirm(`Publish "${displayName}" to registry?`);
    if (!confirmed) {
      console.log(pc.yellow('Cancelled.'));
      process.exit(0);
    }

    const spinner = ora('Publishing skill...').start();
    try {
      spinner.text = 'Publishing to registry...';
      const res = await fetch(`${config.registry}/api/admin/skills`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          owner: 'local',
          repo: 'skills',
          name: displayName,
          description: meta.description,
          tags: meta.tags,
          content,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Registry error: ${err}`);
      }

      spinner.succeed(`Published ${pc.green(displayName)} to registry`);
    } catch (err) {
      spinner.fail('Publish failed');
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
  .command('token <action> [value]')
  .description('Manage registry API tokens (list/create/revoke)')
  .option('-n, --name <name>', 'Token name for create')
  .option('-p, --permissions <permissions>', 'Comma-separated permissions (read,publish,admin)', 'read')
  .option('-t, --token <token>', 'Admin token override')
  .action(async (action, value, options) => {
    const { registry, token } = getRegistryAuthOrExit(options.token);
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    if (action === 'list') {
      const spinner = ora('Fetching tokens...').start();
      try {
        const res = await fetch(`${registry}/api/admin/tokens`, { headers });
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as {
          tokens: Array<{ id: string; name: string; permissions: string[]; createdAt?: string }>;
        };
        spinner.stop();
        if (!data.tokens?.length) {
          console.log(pc.yellow('No tokens found.'));
          return;
        }
        console.log(pc.bold('\nRegistry tokens:\n'));
        for (const t of data.tokens) {
          console.log(`  ${pc.green(t.name)} ${pc.dim(t.id)}`);
          console.log(`    permissions: ${pc.cyan(t.permissions.join(','))}`);
          if (t.createdAt) console.log(`    created: ${pc.dim(t.createdAt)}`);
        }
        return;
      } catch (err) {
        spinner.fail('Failed to fetch tokens');
        console.error(pc.red(String(err)));
        process.exit(1);
      }
    }

    if (action === 'create') {
      const name = options.name || value;
      if (!name) {
        console.log(pc.yellow('Usage: asr token create <name> --permissions read,publish'));
        process.exit(1);
      }
      const permissions = String(options.permissions || 'read')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

      const spinner = ora('Creating token...').start();
      try {
        const res = await fetch(`${registry}/api/admin/tokens`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name, permissions }),
        });
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as {
          token: { id: string; name: string; permissions: string[]; value: string };
        };
        spinner.succeed(`Created token ${pc.green(data.token.name)} (${pc.dim(data.token.id)})`);
        console.log(pc.bold('\nToken value (shown once):'));
        console.log(pc.cyan(data.token.value));
        return;
      } catch (err) {
        spinner.fail('Failed to create token');
        console.error(pc.red(String(err)));
        process.exit(1);
      }
    }

    if (action === 'revoke') {
      const tokenId = value;
      if (!tokenId) {
        console.log(pc.yellow('Usage: asr token revoke <token-id>'));
        process.exit(1);
      }
      const spinner = ora('Revoking token...').start();
      try {
        const res = await fetch(`${registry}/api/admin/tokens/${tokenId}/revoke`, {
          method: 'POST',
          headers,
        });
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        spinner.succeed(`Revoked token ${pc.green(tokenId)}`);
        return;
      } catch (err) {
        spinner.fail('Failed to revoke token');
        console.error(pc.red(String(err)));
        process.exit(1);
      }
    }

    console.log(pc.yellow('Usage: asr token list | create <name> --permissions read,publish | revoke <token-id>'));
    process.exit(1);
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
