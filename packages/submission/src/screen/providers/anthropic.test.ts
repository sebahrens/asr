import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createAnthropicScreeningProvider } from './anthropic.js';

const anthropicMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: anthropicMock.constructor,
}));

beforeEach(() => {
  anthropicMock.constructor.mockReset();
  anthropicMock.create.mockReset();
  anthropicMock.constructor.mockImplementation(function () {
    return {
      beta: {
        promptCaching: {
          messages: {
            create: anthropicMock.create,
          },
        },
      },
    };
  });
});

describe('createAnthropicScreeningProvider', () => {
  it('calls Anthropic with env config and requests forced structured findings', async () => {
    anthropicMock.create.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'record_screening_findings',
          input: {
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
          },
        },
      ],
    });

    const provider = createAnthropicScreeningProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic-compatible.example.test',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });

    const findings = await provider.complete('screening rubric', '# Packed skill content');

    expect(provider).toMatchObject({
      name: 'anthropic',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });
    expect(anthropicMock.constructor).toHaveBeenCalledWith({
      apiKey: 'anthropic-key',
      baseURL: 'https://anthropic-compatible.example.test',
    });
    expect(anthropicMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-5',
        temperature: 0,
        betas: ['prompt-caching-2024-07-31'],
        system: [
          {
            type: 'text',
            text: 'screening rubric',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: '# Packed skill content',
          },
        ],
        tool_choice: {
          type: 'tool',
          name: 'record_screening_findings',
        },
      }),
    );
    expect(anthropicMock.create.mock.calls[0]?.[0].tools[0]).toMatchObject({
      name: 'record_screening_findings',
      input_schema: {
        required: ['findings'],
        properties: {
          findings: {
            type: 'array',
          },
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

  it('returns an empty findings array from the tool input', async () => {
    anthropicMock.create.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'record_screening_findings',
          input: {
            findings: [],
          },
        },
      ],
    });

    const provider = createAnthropicScreeningProvider({
      apiKey: 'anthropic-key',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });

    await expect(provider.complete('rubric', 'content')).resolves.toEqual([]);
  });

  it('rejects responses that do not include the forced findings tool call', async () => {
    anthropicMock.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"findings":[]}' }],
    });

    const provider = createAnthropicScreeningProvider({
      apiKey: 'anthropic-key',
      model: 'claude-sonnet-4-5',
      contextTokens: 200000,
    });

    await expect(provider.complete('rubric', 'content')).rejects.toThrow(
      /did not include the forced findings tool call/,
    );
  });
});
