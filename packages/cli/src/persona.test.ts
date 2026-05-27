import type { PermissionsManifest, SkillManifest } from '@asr/core';
import { describe, expect, it } from 'vitest';
import { generatePersonaSkillMd } from './persona.js';

function perms(overrides: Partial<PermissionsManifest> = {}): PermissionsManifest {
  return {
    network: false,
    filesystem: 'none',
    subprocess: false,
    environment: [],
    ...overrides,
  };
}

function persona(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'financial-analyst',
    version: '1.0.0',
    author: 'finance-team',
    description: 'Expert financial analysis with XLSX tools',
    tags: ['finance'],
    kind: 'persona',
    persona_mode: 'inject',
    permissions: perms({ filesystem: 'read-write-own', subprocess: true }),
    ...overrides,
  };
}

describe('generatePersonaSkillMd', () => {
  it('inject mode emits when_to_use: always', () => {
    const out = generatePersonaSkillMd(persona(), 'You are a senior financial analyst.');
    const frontmatter = out.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/when_to_use:\s*always/);
    expect(out).toContain('You are a senior financial analyst.');
  });

  it('inject mode sets user-invocable and disables model invocation gate', () => {
    const out = generatePersonaSkillMd(persona(), 'body');
    const frontmatter = out.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/user-invocable:\s*true/);
    expect(frontmatter).toMatch(/disable-model-invocation:\s*false/);
  });

  it('inject mode maps permissions to claude allowed-tools', () => {
    const m = persona({
      permissions: perms({ filesystem: 'read-write-own', subprocess: true, network: true }),
    });
    const out = generatePersonaSkillMd(m, 'body');
    const frontmatter = out.split('---')[1] ?? '';
    const tools = frontmatter.match(/allowed-tools:\s*(.+)/)?.[1] ?? '';
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
  });

  it('inject mode defaults persona_mode to inject when omitted', () => {
    const m = persona({ persona_mode: undefined });
    const out = generatePersonaSkillMd(m, 'body');
    expect(out.split('---')[1]).toMatch(/when_to_use:\s*always/);
  });

  it('delegate mode includes Agent in allowed-tools and inlines resolved references', () => {
    const m = persona({
      name: 'researcher',
      description: 'Deep research with multi-source synthesis',
      persona_mode: 'delegate',
      references: ['code-review'],
      permissions: perms({ network: true, filesystem: 'read-own' }),
    });
    const out = generatePersonaSkillMd(
      m,
      'Body of the delegate persona.',
      { 'code-review': 'Reviews code for security issues.' },
    );
    const frontmatter = out.split('---')[1] ?? '';
    const tools = frontmatter.match(/allowed-tools:\s*(.+)/)?.[1] ?? '';
    expect(tools).toContain('Agent');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('Read');
    expect(out).toContain('### code-review');
    expect(out).toContain('Reviews code for security issues.');
    expect(out).toContain('Body of the delegate persona.');
  });

  it('delegate mode handles persona with no references', () => {
    const m = persona({
      persona_mode: 'delegate',
      references: undefined,
    });
    const out = generatePersonaSkillMd(m, 'body');
    const frontmatter = out.split('---')[1] ?? '';
    expect(frontmatter.match(/allowed-tools:\s*(.+)/)?.[1]).toContain('Agent');
    expect(out).not.toContain('### ');
  });

  it('delegate mode flags unresolved references rather than silently dropping', () => {
    const m = persona({
      persona_mode: 'delegate',
      references: ['absent-skill'],
    });
    const out = generatePersonaSkillMd(m, 'body', {});
    expect(out).toContain('### absent-skill');
    expect(out).toContain('unresolved reference: absent-skill');
  });

  it('delegate mode targets codex when agent is codex', () => {
    const m = persona({
      persona_mode: 'delegate',
      permissions: perms({ subprocess: true }),
    });
    const out = generatePersonaSkillMd(m, 'body', {}, { agent: 'codex' });
    const tools = out.split('---')[1]?.match(/allowed-tools:\s*(.+)/)?.[1] ?? '';
    expect(tools).toContain('subagent');
    expect(tools).toContain('shell');
    expect(tools).not.toContain('Agent');
    expect(tools).not.toContain('Bash');
  });

  it('quotes YAML scalars that contain colons', () => {
    const m = persona({ description: 'Reviews: security and quality' });
    const out = generatePersonaSkillMd(m, 'body');
    expect(out).toContain('description: "Reviews: security and quality"');
  });

  it('rejects non-persona manifests', () => {
    const m: SkillManifest = persona({ kind: 'skill', persona_mode: undefined });
    expect(() => generatePersonaSkillMd(m, 'body')).toThrow(/kind:persona/);
  });

  it('omits file/web tools when permissions are minimal', () => {
    const m = persona({
      permissions: perms({ filesystem: 'none', subprocess: false, network: false }),
    });
    const out = generatePersonaSkillMd(m, 'body');
    const toolsLine = out.split('\n').find((l) => l.startsWith('allowed-tools:')) ?? '';
    expect(toolsLine.replace('allowed-tools:', '').trim()).toBe('');
  });
});
