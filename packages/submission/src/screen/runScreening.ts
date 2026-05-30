import type {
  ScreeningFinding,
  ScreeningReport,
  SkillClassification,
  SkillManifest,
} from '@asr/core';
import { getEnv } from '../env.js';
import { packContent } from './packContent.js';
import { buildScreeningUserContent, SCREENING_SYSTEM_RUBRIC } from './prompt.js';
import { createScreeningProvider } from './providers/factory.js';
import type { ScreeningProvider } from './providers/types.js';

export interface RunScreeningInput {
  submissionId: string;
  contentHash: string;
  extractedDir: string;
  manifest: SkillManifest;
  questionnaire?: unknown;
  classification: SkillClassification;
}

export type ScreeningProviderFactory = () => ScreeningProvider | null;

const DEFAULT_CHARS_PER_TOKEN = 3.5;
const DEFAULT_RESERVE_OUTPUT_TOKENS = 8_000;

export async function runScreening(
  input: RunScreeningInput,
  providerFactory: ScreeningProviderFactory = defaultProviderFactory,
): Promise<ScreeningReport> {
  const startedAt = new Date();
  const provider = providerFactory();

  if (!provider) {
    return buildReport({
      input,
      startedAt,
      provider: 'none',
      model: 'none',
      contextTokens: 0,
      status: 'skipped',
      truncated: false,
      findings: [],
    });
  }

  try {
    const env = getEnv();
    const charsPerToken = env.LLM_SCREEN_CHARS_PER_TOKEN ?? DEFAULT_CHARS_PER_TOKEN;
    const packed = await packContent({
      extractedDir: input.extractedDir,
      manifest: input.manifest,
      questionnaireResponses: input.questionnaire,
      estimatedRubricTokens: estimateTokens(SCREENING_SYSTEM_RUBRIC, charsPerToken),
      contextTokens: provider.contextTokens,
      reserveOutputTokens: env.LLM_SCREEN_RESERVE_OUTPUT_TOKENS ?? DEFAULT_RESERVE_OUTPUT_TOKENS,
      charsPerToken,
    });
    const providerFindings = await provider.complete(
      SCREENING_SYSTEM_RUBRIC,
      buildScreeningUserContent({ packed }),
    );
    const findings = packed.truncated
      ? [...providerFindings, truncatedFinding(input.classification)]
      : providerFindings;

    return buildReport({
      input,
      startedAt,
      provider: provider.name,
      model: provider.model,
      contextTokens: provider.contextTokens,
      status: findings.length > 0 ? 'flagged' : 'clean',
      truncated: packed.truncated,
      findings,
    });
  } catch {
    return buildReport({
      input,
      startedAt,
      provider: provider.name,
      model: provider.model,
      contextTokens: provider.contextTokens,
      status: 'error',
      truncated: false,
      findings: [],
    });
  }
}

function defaultProviderFactory(): ScreeningProvider | null {
  return createScreeningProvider(getEnv());
}

function buildReport(input: {
  input: RunScreeningInput;
  startedAt: Date;
  provider: ScreeningReport['provider'];
  model: string;
  contextTokens: number;
  status: ScreeningReport['status'];
  truncated: boolean;
  findings: ScreeningFinding[];
}): ScreeningReport {
  const completedAt = new Date();

  return {
    submissionId: input.input.submissionId,
    contentHash: input.input.contentHash,
    provider: input.provider,
    model: input.model,
    contextTokens: input.contextTokens,
    status: input.status,
    truncated: input.truncated,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - input.startedAt.getTime(),
    findings: input.findings,
  };
}

function truncatedFinding(classification: SkillClassification): ScreeningFinding {
  return {
    category: 'description',
    severity: classification === 'md-only' ? 'medium' : 'low',
    message: 'LLM screening content exceeded the configured context budget and was truncated.',
  };
}

function estimateTokens(content: string, charsPerToken: number): number {
  if (content.length === 0) {
    return 0;
  }
  return Math.ceil(content.length / charsPerToken);
}
