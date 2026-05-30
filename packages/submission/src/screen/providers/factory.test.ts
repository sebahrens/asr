import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../env.js';
import { createScreeningProvider } from './factory.js';
import type { ScreeningProvider } from './types.js';

const baseEnv = {
  LLM_SCREEN_CONTEXT_TOKENS: 200000,
} as Env;

function fakeProvider(name: ScreeningProvider['name'], contextTokens: number): ScreeningProvider {
  return {
    name,
    model: `${name}-model`,
    contextTokens,
    complete: vi.fn(async () => []),
  };
}

describe('createScreeningProvider', () => {
  it('returns null when LLM screening is unconfigured', () => {
    expect(createScreeningProvider(baseEnv)).toBeNull();
  });

  it('builds an OpenAI provider from env', () => {
    const buildOpenAI = vi.fn(() => fakeProvider('openai', 1000000));

    const provider = createScreeningProvider(
      {
        ...baseEnv,
        LLM_SCREEN_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://openai-compatible.example.test/v1',
        OPENAI_MODEL: 'gpt-4.1',
        LLM_SCREEN_CONTEXT_TOKENS: 1000000,
      },
      {
        openai: buildOpenAI,
      },
    );

    expect(provider).toMatchObject({
      name: 'openai',
      contextTokens: 1000000,
    });
    expect(buildOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-key',
      baseUrl: 'https://openai-compatible.example.test/v1',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });
  });

  it('builds an Anthropic provider from env', () => {
    const buildAnthropic = vi.fn(() => fakeProvider('anthropic', 200000));

    const provider = createScreeningProvider(
      {
        ...baseEnv,
        LLM_SCREEN_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_BASE_URL: 'https://anthropic-compatible.example.test',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      },
      {
        anthropic: buildAnthropic,
      },
    );

    expect(provider).toMatchObject({
      name: 'anthropic',
      contextTokens: 200000,
    });
    expect(buildAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic-compatible.example.test',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });
  });

  it('returns null when the selected provider is missing required env', () => {
    expect(
      createScreeningProvider({
        ...baseEnv,
        LLM_SCREEN_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-key',
      }),
    ).toBeNull();
  });

  it('builds the default Anthropic provider implementation', () => {
    const provider = createScreeningProvider({
      ...baseEnv,
      LLM_SCREEN_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    });

    expect(provider).toMatchObject({
      name: 'anthropic',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });
  });

  it('throws when configured provider has no registered implementation', () => {
    expect(() =>
      createScreeningProvider({
        ...baseEnv,
        LLM_SCREEN_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_MODEL: 'gpt-4.1',
      }),
    ).toThrow(/No LLM screening provider implementation registered for openai/);
  });
});
