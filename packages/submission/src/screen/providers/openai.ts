import OpenAI from 'openai';
import type { ScreeningFinding } from '@asr/core';
import type { ScreeningProvider, ScreeningProviderConfig } from './types.js';

const MAX_OUTPUT_TOKENS = 4096;

export function createOpenAIScreeningProvider(config: ScreeningProviderConfig): ScreeningProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return {
    name: 'openai',
    model: config.model,
    contextTokens: config.contextTokens,
    async complete(system, userContent) {
      const response = await client.chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'system',
            content: system,
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'screening_findings',
            strict: true,
            schema: screeningFindingsSchema,
          },
        },
      });

      return extractFindings(response.choices[0]?.message?.content);
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
        required: ['category', 'severity', 'file', 'line', 'declared', 'observed', 'message'],
        properties: {
          category: {
            type: 'string',
            enum: ['permission', 'questionnaire', 'description', 'malicious'],
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          file: {
            type: ['string', 'null'],
          },
          line: {
            type: ['integer', 'null'],
            minimum: 1,
          },
          declared: {
            type: ['string', 'null'],
          },
          observed: {
            type: ['string', 'null'],
          },
          message: {
            type: 'string',
          },
        },
      },
    },
  },
} as const;

function extractFindings(content: unknown): ScreeningFinding[] {
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('OpenAI screening response did not include JSON content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('OpenAI screening response contained invalid JSON', { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
    throw new Error('OpenAI screening response did not include findings array');
  }

  return parsed.findings.map((finding, index) => parseFinding(finding, index));
}

function parseFinding(input: unknown, index: number): ScreeningFinding {
  if (!isRecord(input)) {
    throw new Error(`OpenAI screening finding ${index} is not an object`);
  }

  const { category, severity, file, line, declared, observed, message } = input;

  if (!isCategory(category)) {
    throw new Error(`OpenAI screening finding ${index} has invalid category`);
  }
  if (!isSeverity(severity)) {
    throw new Error(`OpenAI screening finding ${index} has invalid severity`);
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error(`OpenAI screening finding ${index} has invalid message`);
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
