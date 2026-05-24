import { describe, expect, it } from 'vitest';
import { classifySkill } from './classify.js';

describe('classifySkill', () => {
  it('classifies whitelisted content files as md-only', () => {
    expect(classifySkill(['SKILL.md', 'img/logo.png', 'manifest.yaml'])).toBe('md-only');
  });

  it('classifies code extensions as code-containing', () => {
    expect(classifySkill(['SKILL.md', 'hack.py'])).toBe('code-containing');
  });

  it('classifies extensionless files as code-containing', () => {
    expect(classifySkill(['SKILL.md', 'Makefile'])).toBe('code-containing');
  });
});
