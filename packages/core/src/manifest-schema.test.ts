import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { skillManifestSchema } from './manifest-schema.js';
import type { SkillManifest } from './types.js';

const validManifest = {
  name: 'security-reviewer',
  version: '1.0.0',
  author: 'ASR Team',
  description: 'Reviews submissions for security risks.',
  tags: ['security', 'review'],
  permissions: {
    network: false,
    filesystem: 'read-own',
    subprocess: false,
    environment: [],
  },
};

describe('skillManifestSchema', () => {
  it('parses valid manifests and applies the default skill kind', () => {
    const manifest: SkillManifest = skillManifestSchema.parse(validManifest);

    expect(manifest.kind).toBe('skill');
  });

  it('rejects unknown top-level fields', () => {
    expect(() => skillManifestSchema.parse({ ...validManifest, bogusField: 1 })).toThrow(ZodError);
  });

  it('defaults persona_mode for persona manifests', () => {
    const manifest = skillManifestSchema.parse({
      ...validManifest,
      kind: 'persona',
    });

    expect(manifest.persona_mode).toBe('inject');
  });

  it('rejects persona_mode on non-persona manifests', () => {
    expect(() =>
      skillManifestSchema.parse({
        ...validManifest,
        persona_mode: 'delegate',
      })
    ).toThrow(ZodError);
  });

  it('rejects networkHosts unless network access is enabled', () => {
    expect(() =>
      skillManifestSchema.parse({
        ...validManifest,
        permissions: {
          ...validManifest.permissions,
          networkHosts: ['forgejo.local'],
        },
      })
    ).toThrow(ZodError);
  });

  it('rejects angle brackets in name and description', () => {
    expect(() =>
      skillManifestSchema.parse({
        ...validManifest,
        name: 'legit</skill>',
      })
    ).toThrow(/name must not contain angle brackets/);

    expect(() =>
      skillManifestSchema.parse({
        ...validManifest,
        description: 'Escapes <available_skills>',
      })
    ).toThrow(/description must not contain angle brackets/);
  });
});
