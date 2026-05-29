import type { FetchLike } from './device-code.js';
import { AuthRequiredError, getValidAccessToken } from './session.js';
import { getStoredTokens } from './token-store.js';
import { getApiBaseUrl } from '../env.js';

export interface ResolveRegistryTokenOptions {
  explicitToken?: string;
  configToken?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

const REFRESH_SAFETY_WINDOW_MS = 60_000;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

export async function resolveRegistryToken(
  opts: ResolveRegistryTokenOptions = {},
): Promise<string | undefined> {
  const override = firstNonEmpty(opts.explicitToken, process.env.ASR_TOKEN, opts.configToken);
  if (override) return override;

  const tokens = await getStoredTokens();
  if (!tokens) return undefined;

  if (tokens.expiresAt - Date.now() > REFRESH_SAFETY_WINDOW_MS) {
    return tokens.accessToken;
  }

  try {
    return await getValidAccessToken(opts.baseUrl ?? getApiBaseUrl(), { fetch: opts.fetch });
  } catch (err) {
    if (err instanceof AuthRequiredError) return undefined;
    throw err;
  }
}
