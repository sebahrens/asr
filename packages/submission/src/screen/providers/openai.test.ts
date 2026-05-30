import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createOpenAIScreeningProvider } from './openai.js';

const openAIMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: openAIMock.constructor,
}));

beforeEach(() => {
  openAIMock.constructor.mockReset();
  openAIMock.create.mockReset();
  openAIMock.constructor.mockImplementation(function () {
    return {
      chat: {
        completions: {
          create: openAIMock.create,
        },
      },
    };
  });
});

describe('createOpenAIScreeningProvider', () => {
  it('calls OpenAI with env config and requests JSON schema findings', async () => {
    openAIMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  category: 'permission',
                  severity: 'high',
                  file: 'scripts/run.ts',
                  line: 7,
                  declared: 'network: false',
                  observed: 'fetch("https://example.com")',
                  message: 'Declared permissions do not match observed network use.',
                },
              ],
            }),
          },
        },
      ],
    });

    const provider = createOpenAIScreeningProvider({
      apiKey: 'openai-key',
      baseUrl: 'https://openai-compatible.example.test/v1',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });

    const findings = await provider.complete('screening rubric', '# Packed skill content');

    expect(provider).toMatchObject({
      name: 'openai',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });
    expect(openAIMock.constructor).toHaveBeenCalledWith({
      apiKey: 'openai-key',
      baseURL: 'https://openai-compatible.example.test/v1',
    });
    expect(openAIMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4.1',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'screening rubric',
          },
          {
            role: 'user',
            content: '# Packed skill content',
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: expect.objectContaining({
            name: 'screening_findings',
            strict: true,
          }),
        },
      }),
    );
    expect(openAIMock.create.mock.calls[0]?.[0].response_format.json_schema.schema).toMatchObject({
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
        },
      },
    });
    expect(findings).toEqual([
      {
        category: 'permission',
        severity: 'high',
        file: 'scripts/run.ts',
        line: 7,
        declared: 'network: false',
        observed: 'fetch("https://example.com")',
        message: 'Declared permissions do not match observed network use.',
      },
    ]);
  });

  it('returns an empty findings array from JSON content', async () => {
    openAIMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"findings":[]}',
          },
        },
      ],
    });

    const provider = createOpenAIScreeningProvider({
      apiKey: 'openai-key',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });

    await expect(provider.complete('rubric', 'content')).resolves.toEqual([]);
  });

  it('ignores null optional fields returned by strict JSON schema', async () => {
    openAIMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  category: 'description',
                  severity: 'medium',
                  file: null,
                  line: null,
                  declared: null,
                  observed: null,
                  message: 'The description materially understates behavior.',
                },
              ],
            }),
          },
        },
      ],
    });

    const provider = createOpenAIScreeningProvider({
      apiKey: 'openai-key',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });

    await expect(provider.complete('rubric', 'content')).resolves.toEqual([
      {
        category: 'description',
        severity: 'medium',
        message: 'The description materially understates behavior.',
      },
    ]);
  });

  it('rejects responses that do not include JSON content', async () => {
    openAIMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
          },
        },
      ],
    });

    const provider = createOpenAIScreeningProvider({
      apiKey: 'openai-key',
      model: 'gpt-4.1',
      contextTokens: 1000000,
    });

    await expect(provider.complete('rubric', 'content')).rejects.toThrow(/did not include JSON/);
  });
});
