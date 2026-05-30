import type { ScreeningProviderKind } from '@asr/core';
import type { Env } from '../../env.js';
import { createAnthropicScreeningProvider } from './anthropic.js';
import type {
  ScreeningProvider,
  ScreeningProviderConfig,
  ScreeningProviderRegistry,
} from './types.js';

type ScreeningEnv = Pick<
  Env,
  | 'LLM_SCREEN_PROVIDER'
  | 'LLM_SCREEN_CONTEXT_TOKENS'
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'OPENAI_MODEL'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_BASE_URL'
  | 'ANTHROPIC_MODEL'
>;

export function createScreeningProvider(
  env: ScreeningEnv,
  registry: ScreeningProviderRegistry = defaultProviderRegistry,
): ScreeningProvider | null {
  if (!env.LLM_SCREEN_PROVIDER) {
    return null;
  }

  const config = providerConfig(env, env.LLM_SCREEN_PROVIDER);
  if (!config) {
    return null;
  }

  const build = registry[env.LLM_SCREEN_PROVIDER];
  if (!build) {
    throw new Error(
      `No LLM screening provider implementation registered for ${env.LLM_SCREEN_PROVIDER}`,
    );
  }

  return build(config);
}

export const buildScreeningProvider = createScreeningProvider;

const defaultProviderRegistry: ScreeningProviderRegistry = {
  anthropic: createAnthropicScreeningProvider,
};

function providerConfig(
  env: ScreeningEnv,
  provider: ScreeningProviderKind,
): ScreeningProviderConfig | null {
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) {
      return null;
    }

    return {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL,
      contextTokens: env.LLM_SCREEN_CONTEXT_TOKENS,
    };
  }

  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL) {
    return null;
  }

  return {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    model: env.ANTHROPIC_MODEL,
    contextTokens: env.LLM_SCREEN_CONTEXT_TOKENS,
  };
}
