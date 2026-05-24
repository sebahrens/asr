import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production']),
    AUTH_MODE: z.enum(['mock', 'entra']),
    FORGEJO_URL: z.string().optional(),
    DATABASE_PATH: z.string().optional(),
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
