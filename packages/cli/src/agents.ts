import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTarget } from './tool-mapping.js';

export type { AgentTarget } from './tool-mapping.js';

export interface DetectAgentsOptions {
  explicit?: 'claude' | 'codex' | 'both';
  cwd?: string;
}

export function detectAgents(opts: DetectAgentsOptions = {}): AgentTarget[] {
  if (opts.explicit === 'both') return ['claude', 'codex'];
  if (opts.explicit === 'claude') return ['claude'];
  if (opts.explicit === 'codex') return ['codex'];

  const cwd = opts.cwd ?? process.cwd();
  const hasClaude = existsSync(join(cwd, '.claude'));
  const hasCodex = existsSync(join(cwd, '.codex'));

  if (hasClaude && hasCodex) return ['claude', 'codex'];
  if (hasClaude) return ['claude'];
  if (hasCodex) return ['codex'];

  return ['claude', 'codex'];
}

export interface AgentSkillDirOptions {
  global?: boolean;
  cwd?: string;
}

export function agentSkillDir(
  agent: AgentTarget,
  name: string,
  opts: AgentSkillDirOptions = {}
): string {
  if (name === '.' || name === '..' || !/^[a-z0-9._-]+$/.test(name)) {
    throw new Error(
      'Invalid skill name. Expected lowercase letters, numbers, dots, underscores, or hyphens',
    );
  }
  const root = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  const agentDir = agent === 'claude' ? '.claude' : '.codex';
  return join(root, agentDir, 'skills', name);
}
