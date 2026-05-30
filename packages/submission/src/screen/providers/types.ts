import type { ScreeningFinding, ScreeningProviderKind } from '@asr/core';

export interface ScreeningProvider {
  name: ScreeningProviderKind;
  contextTokens: number;
  complete(system: string, userContent: string): Promise<ScreeningFinding[]>;
}

export interface ScreeningProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  contextTokens: number;
}

export type ScreeningProviderBuilder = (config: ScreeningProviderConfig) => ScreeningProvider;

export type ScreeningProviderRegistry = Partial<
  Record<ScreeningProviderKind, ScreeningProviderBuilder>
>;
