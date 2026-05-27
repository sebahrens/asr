import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSkillDir, detectAgents } from './agents.js';

describe('detectAgents', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'asr-agents-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns both when explicit:both regardless of cwd contents', () => {
    expect(detectAgents({ explicit: 'both', cwd: tmp })).toEqual(['claude', 'codex']);
  });

  it('returns only codex when explicit:codex', () => {
    mkdirSync(join(tmp, '.claude'));
    expect(detectAgents({ explicit: 'codex', cwd: tmp })).toEqual(['codex']);
  });

  it('returns only claude when explicit:claude', () => {
    mkdirSync(join(tmp, '.codex'));
    expect(detectAgents({ explicit: 'claude', cwd: tmp })).toEqual(['claude']);
  });

  it('detects both when both .claude and .codex exist', () => {
    mkdirSync(join(tmp, '.claude'));
    mkdirSync(join(tmp, '.codex'));
    expect(detectAgents({ cwd: tmp })).toEqual(['claude', 'codex']);
  });

  it('detects only claude when only .claude exists', () => {
    mkdirSync(join(tmp, '.claude'));
    expect(detectAgents({ cwd: tmp })).toEqual(['claude']);
  });

  it('detects only codex when only .codex exists', () => {
    mkdirSync(join(tmp, '.codex'));
    expect(detectAgents({ cwd: tmp })).toEqual(['codex']);
  });

  it('defaults to both when neither directory is present', () => {
    expect(detectAgents({ cwd: tmp })).toEqual(['claude', 'codex']);
  });
});

describe('agentSkillDir', () => {
  it('returns project-relative path for claude', () => {
    const cwd = `${sep}fake${sep}proj`;
    expect(agentSkillDir('claude', 'x', { global: false, cwd })).toBe(
      join(cwd, '.claude', 'skills', 'x')
    );
  });

  it('returns project-relative path for codex', () => {
    const cwd = `${sep}fake${sep}proj`;
    expect(agentSkillDir('codex', 'x', { global: false, cwd })).toBe(
      join(cwd, '.codex', 'skills', 'x')
    );
  });

  it('returns home-rooted path when global:true for claude', () => {
    expect(agentSkillDir('claude', 'x', { global: true })).toBe(
      join(homedir(), '.claude', 'skills', 'x')
    );
  });

  it('returns home-rooted path when global:true for codex', () => {
    expect(agentSkillDir('codex', 'x', { global: true })).toBe(
      join(homedir(), '.codex', 'skills', 'x')
    );
  });

  it('uses process.cwd() by default for project scope', () => {
    const result = agentSkillDir('claude', 'x', { global: false });
    expect(result).toBe(join(process.cwd(), '.claude', 'skills', 'x'));
  });

  it('ends with .claude/skills/<name> for claude project install', () => {
    const result = agentSkillDir('claude', 'x', { global: false, cwd: '/tmp/proj' });
    expect(result.endsWith(join('.claude', 'skills', 'x'))).toBe(true);
  });
});
