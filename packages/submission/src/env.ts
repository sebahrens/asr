import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z.enum(['development', 'production']),
    AUTH_MODE: z.enum(['mock', 'entra']),
    MOCK_USER_SUB: z.string().optional(),
    MOCK_USER_ROLES: z.string().optional(),
    AZURE_TENANT_ID: z.string().optional(),
    AZURE_CLIENT_ID: z.string().optional(),
    SCANNER_IMAGE: z.string().optional(),
    SCANNER_TIMEOUT_SECONDS: z.string().optional(),
    SCAN_TIMEOUT_SECONDS: z.string().optional(),
    SCANNER_SEVERITY_THRESHOLD: z.string().optional(),
    SCAN_SEVERITY_THRESHOLD: z.string().optional(),
    SCAN_SIGNING_KEY: z.string().optional(),
    SCAN_SIGNING_DISABLED: z.enum(['true', 'false']).optional(),
    FORGEJO_URL: z.string().optional(),
    FORGEJO_UPLOAD_TOKEN: z.string().optional(),
    FORGEJO_MERGE_TOKEN: z.string().optional(),
    FORGEJO_OWNER: z.string().optional(),
    FORGEJO_REPO: z.string().optional(),
    FORGEJO_MARKETPLACE_OWNER: z.string().optional(),
    FORGEJO_MARKETPLACE_REPO: z.string().default('skill-marketplace'),
    FORGEJO_WEBHOOK_SECRET: z.string().optional(),
    DATABASE_PATH: z.string().optional(),
    REGISTRY_INDEX_PATH: z.string().optional(),
    AUDIT_HMAC_KEY_ID: z.string().optional(),
    AUDIT_HMAC_KEY_BYTES: z.string().optional(),
    AUDIT_GPG_PRIVATE_KEY: z.string().optional(),
    AUDIT_GPG_PASSPHRASE: z.string().optional(),
    NOTIFY_TRANSPORT: z.enum(['memory', 'smtp', 'graph']).default('memory'),
    PUBLIC_BASE_URL: z.string().url().optional(),
    VERACODE_API_KEY_ID: z.string().optional(),
    VERACODE_API_KEY_SECRET: z.string().optional(),
    VERACODE_POLICY: z.string().optional(),
    LLM_SCREEN_PROVIDER: z.enum(['openai', 'anthropic']).optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().optional(),
    OPENAI_MODEL: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),
    LLM_SCREEN_CONTEXT_TOKENS: z.coerce.number().int().positive().default(200000),
    LLM_SCREEN_RESERVE_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
    LLM_SCREEN_CHARS_PER_TOKEN: z.coerce.number().positive().default(3.5),
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

    if (env.AUTH_MODE === 'mock') {
      requireEnv(env, ctx, 'MOCK_USER_SUB', 'when AUTH_MODE=mock');
      requireEnv(env, ctx, 'MOCK_USER_ROLES', 'when AUTH_MODE=mock');
    }

    if (env.AUTH_MODE === 'entra') {
      requireEnv(env, ctx, 'AZURE_TENANT_ID', 'when AUTH_MODE=entra');
      requireEnv(env, ctx, 'AZURE_CLIENT_ID', 'when AUTH_MODE=entra');
    }

    if (env.NODE_ENV === 'production') {
      for (const name of [
        'FORGEJO_URL',
        'FORGEJO_UPLOAD_TOKEN',
        'FORGEJO_MERGE_TOKEN',
        'FORGEJO_OWNER',
        'FORGEJO_REPO',
        'FORGEJO_MARKETPLACE_OWNER',
        'FORGEJO_MARKETPLACE_REPO',
        'FORGEJO_WEBHOOK_SECRET',
        'DATABASE_PATH',
        'PUBLIC_BASE_URL',
        'AUDIT_HMAC_KEY_ID',
        'AUDIT_HMAC_KEY_BYTES',
        'SCAN_SIGNING_KEY',
        'SCANNER_IMAGE',
      ] as const) {
        requireEnv(env, ctx, name, 'in production');
      }
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

    if (env.LLM_SCREEN_PROVIDER === 'openai') {
      requireEnv(env, ctx, 'OPENAI_API_KEY', 'when LLM_SCREEN_PROVIDER=openai');
      requireEnv(env, ctx, 'OPENAI_MODEL', 'when LLM_SCREEN_PROVIDER=openai');
    }

    if (env.LLM_SCREEN_PROVIDER === 'anthropic') {
      requireEnv(env, ctx, 'ANTHROPIC_API_KEY', 'when LLM_SCREEN_PROVIDER=anthropic');
      requireEnv(env, ctx, 'ANTHROPIC_MODEL', 'when LLM_SCREEN_PROVIDER=anthropic');
    }
  });

export type Env = z.infer<typeof envSchema>;
type EnvShape = z.infer<typeof envSchema>;

function requireEnv(
  env: EnvShape,
  ctx: z.RefinementCtx,
  name: keyof EnvShape,
  context: string,
): void {
  if (!env[name]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [name],
      message: `FATAL: ${name} is required ${context}`,
    });
  }
}

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

export function screeningConfigured(env: Env): boolean {
  if (env.LLM_SCREEN_PROVIDER === 'openai') {
    return Boolean(env.OPENAI_API_KEY);
  }

  if (env.LLM_SCREEN_PROVIDER === 'anthropic') {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  return false;
}

export function getEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(raw);
}
