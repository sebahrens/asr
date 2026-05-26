import { z } from 'zod';
import type { SkillManifest } from './types.js';

const permissionsManifestSchema = z
  .object({
    network: z.boolean(),
    networkHosts: z.array(z.string()).optional(),
    filesystem: z.enum(['none', 'read-own', 'read-write-own']),
    subprocess: z.boolean(),
    environment: z.array(z.string()),
  })
  .strict();

const compatibilityManifestSchema = z
  .object({
    'claude-code': z.string().optional(),
    codex: z.string().optional(),
  })
  .strict();

const baseSkillManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    author: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    kind: z.enum(['skill', 'persona']).default('skill'),
    persona_mode: z.enum(['inject', 'delegate']).optional(),
    references: z.array(z.string()).optional(),
    entrypoint: z.string().optional(),
    dependencies: z.record(z.string()).optional(),
    permissions: permissionsManifestSchema,
    compatibility: compatibilityManifestSchema.optional(),
  })
  .strict();

export const skillManifestSchema: z.ZodType<SkillManifest, z.ZodTypeDef, unknown> = baseSkillManifestSchema
  .superRefine((manifest, ctx) => {
    if (manifest.kind === 'skill' && manifest.persona_mode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['persona_mode'],
        message: 'persona_mode is only valid when kind is persona',
      });
    }

    if (manifest.permissions.networkHosts !== undefined && !manifest.permissions.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', 'networkHosts'],
        message: 'networkHosts requires permissions.network to be true',
      });
    }
  })
  .transform((manifest) => {
    if (manifest.kind === 'persona' && manifest.persona_mode === undefined) {
      return { ...manifest, persona_mode: 'inject' };
    }

    return manifest;
  });
