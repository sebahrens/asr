import Anthropic from '@anthropic-ai/sdk';
import type { ScreeningFinding } from '@asr/core';
import type { ScreeningProvider, ScreeningProviderConfig } from './types.js';

const TOOL_NAME = 'record_screening_findings';
const MAX_OUTPUT_TOKENS = 4096;
const PROMPT_CACHING_BETA = 'prompt-caching-2024-07-31';

export function createAnthropicScreeningProvider(
  config: ScreeningProviderConfig,
): ScreeningProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return {
    name: 'anthropic',
    model: config.model,
    contextTokens: config.contextTokens,
    async complete(system, userContent) {
      const response = await client.beta.promptCaching.messages.create({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        betas: [PROMPT_CACHING_BETA],
        system: [
          {
            type: 'text',
            text: system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
        tools: [
          {
            name: TOOL_NAME,
            description:
              'Record concrete ASR LLM content screening findings. Use an empty findings array when no issues are found.',
            input_schema: screeningFindingsSchema,
          },
        ],
        tool_choice: {
          type: 'tool',
          name: TOOL_NAME,
        },
      });

      return extractFindings(response.content);
    },
  };
}

const screeningFindingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'severity', 'message'],
        properties: {
          category: {
            type: 'string',
            enum: ['permission', 'questionnaire', 'description', 'malicious'],
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          file: { type: 'string' },
          line: {
            type: 'integer',
            minimum: 1,
          },
          declared: { type: 'string' },
          observed: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
} as const;

function extractFindings(content: unknown[]): ScreeningFinding[] {
  const toolUse = content.find(
    (block): block is { type: 'tool_use'; name: string; input: unknown } =>
      isRecord(block) && block.type === 'tool_use' && block.name === TOOL_NAME,
  );

  if (!toolUse) {
    throw new Error('Anthropic screening response did not include the forced findings tool call');
  }

  return parseToolInput(toolUse.input);
}

function parseToolInput(input: unknown): ScreeningFinding[] {
  if (!isRecord(input) || !Array.isArray(input.findings)) {
    throw new Error('Anthropic screening tool input did not include findings array');
  }

  return input.findings.map((finding, index) => parseFinding(finding, index));
}

function parseFinding(input: unknown, index: number): ScreeningFinding {
  if (!isRecord(input)) {
    throw new Error(`Anthropic screening finding ${index} is not an object`);
  }

  const { category, severity, file, line, declared, observed, message } = input;

  if (!isCategory(category)) {
    throw new Error(`Anthropic screening finding ${index} has invalid category`);
  }
  if (!isSeverity(severity)) {
    throw new Error(`Anthropic screening finding ${index} has invalid severity`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`Anthropic screening finding ${index} has invalid message`);
  }

  const parsed: ScreeningFinding = {
    category,
    severity,
    message,
  };

  if (typeof file === 'string') {
    parsed.file = file;
  }
  if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
    parsed.line = line;
  }
  if (typeof declared === 'string') {
    parsed.declared = declared;
  }
  if (typeof observed === 'string') {
    parsed.observed = observed;
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is ScreeningFinding['category'] {
  return (
    value === 'permission' ||
    value === 'questionnaire' ||
    value === 'description' ||
    value === 'malicious'
  );
}

function isSeverity(value: unknown): value is ScreeningFinding['severity'] {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low';
}
