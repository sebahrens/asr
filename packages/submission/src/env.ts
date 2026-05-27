import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production']),
    AUTH_MODE: z.enum(['mock', 'entra']),
    FORGEJO_URL: z.string().optional(),
    FORGEJO_UPLOAD_TOKEN: z.string().optional(),
    FORGEJO_MERGE_TOKEN: z.string().optional(),
    FORGEJO_OWNER: z.string().optional(),
    FORGEJO_REPO: z.string().optional(),
    FORGEJO_MARKETPLACE_OWNER: z.string().optional(),
    FORGEJO_MARKETPLACE_REPO: z.string().default('skill-marketplace'),
    DATABASE_PATH: z.string().optional(),
    NOTIFY_TRANSPORT: z.enum(['memory', 'smtp', 'graph']).default('memory'),
    PUBLIC_BASE_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_MODE'],
        message: 'FATAL: AUTH_MODE=mock is forbidden in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  return envSchema.parse(raw);
}

export function getEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(raw);
}
