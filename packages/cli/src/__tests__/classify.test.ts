import { describe, expect, it } from 'vitest';
import { classifySkill } from '../publish/classify.js';

describe('classifySkill', () => {
  it('classifies a SKILL.md plus a PNG image as md-only', () => {
    expect(classifySkill(['SKILL.md', 'img/logo.png'])).toBe('md-only');
  });

  it('classifies a SKILL.md with a Python script as code-containing', () => {
    expect(classifySkill(['SKILL.md', 'scripts/run.py'])).toBe('code-containing');
  });

  it('classifies extensionless files as code-containing', () => {
    expect(classifySkill(['SKILL.md', 'Makefile'])).toBe('code-containing');
  });

  it('accepts uppercase extensions via case-insensitive lookup', () => {
    expect(classifySkill(['README.MD', 'cover.JPG', 'config.YAML'])).toBe('md-only');
  });

  it('rejects unknown extensions as code-containing', () => {
    expect(classifySkill(['SKILL.md', 'bin/tool.exe'])).toBe('code-containing');
  });

  it('accepts every whitelisted extension', () => {
    const files = [
      'a.md',
      'b.txt',
      'c.rst',
      'd.png',
      'e.jpg',
      'f.jpeg',
      'g.gif',
      'h.svg',
      'i.webp',
      'j.yaml',
      'k.yml',
      'l.json',
    ];
    expect(classifySkill(files)).toBe('md-only');
  });
});
