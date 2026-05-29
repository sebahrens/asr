import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production']),
    AUTH_MODE: z.enum(['mock', 'entra']),
    SCANNER_IMAGE: z.string().optional(),
    SCAN_SIGNING_KEY: z.string().optional(),
    SCAN_SIGNING_DISABLED: z.enum(['true', 'false']).optional(),
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

    if (env.NODE_ENV === 'production' && env.SCAN_SIGNING_DISABLED === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCAN_SIGNING_DISABLED'],
        message: 'FATAL: SCAN_SIGNING_DISABLED=true is forbidden in production',
      });
    }

    if (env.NODE_ENV === 'production' && !env.SCAN_SIGNING_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCAN_SIGNING_KEY'],
        message: 'FATAL: SCAN_SIGNING_KEY is required in production',
      });
    }

    if (env.NODE_ENV === 'production' && !env.SCANNER_IMAGE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCANNER_IMAGE'],
        message: 'FATAL: SCANNER_IMAGE is required in production',
      });
    }

    if (
      env.NODE_ENV === 'production' &&
      env.SCANNER_IMAGE &&
      !/[@:]sha256:[0-9a-f]{64}$/i.test(env.SCANNER_IMAGE)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCANNER_IMAGE'],
        message: 'FATAL: SCANNER_IMAGE must be pinned by sha256 digest in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const env = envSchema.parse(raw);
  if (
    env.NODE_ENV !== 'production' &&
    !env.SCAN_SIGNING_KEY &&
    env.SCAN_SIGNING_DISABLED === 'true'
  ) {
    console.warn('WARNING: scanner report signature verification is disabled');
  }
  return env;
}

export function getEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(raw);
}
