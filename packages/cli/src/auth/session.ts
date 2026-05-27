import { Buffer } from 'buffer';
import type { FetchLike } from './device-code.js';
import { getStoredTokens, storeTokens, type StoredTokens } from './token-store.js';

export class AuthRequiredError extends Error {
  constructor(message = 'Authentication required. Run `asr login`.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export interface GetValidAccessTokenOptions {
  fetch?: FetchLike;
}

const REFRESH_SAFETY_WINDOW_MS = 60_000;

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface TokenClaims {
  email?: string;
  name?: string;
  preferred_username?: string;
  sub?: string;
  upn?: string;
}

function endpoint(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalized);
}

function requestBody(extra: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value) body.set(key, value);
  }
  return body;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Refresh response missing ${field}`);
}

function accessTokenClaims(accessToken: string): TokenClaims {
  const [, encodedPayload] = accessToken.split('.');
  if (!encodedPayload) return {};

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return {};
  }
}

function accountFromAccessToken(accessToken: string, fallback: string): string {
  const claims = accessTokenClaims(accessToken);
  return (
    claims.preferred_username ??
    claims.upn ??
    claims.email ??
    claims.name ??
    claims.sub ??
    fallback
  );
}

async function refreshTokens(
  baseUrl: string,
  current: StoredTokens,
  fetchImpl: FetchLike
): Promise<StoredTokens> {
  if (!current.refreshToken) {
    throw new AuthRequiredError('No refresh token available. Run `asr login`.');
  }

  const response = await fetchImpl(endpoint(baseUrl, 'token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: requestBody({
      grant_type: 'refresh_token',
      client_id: process.env.ASR_ENTRA_CLIENT_ID,
      refresh_token: current.refreshToken,
      scope: process.env.ASR_ENTRA_SCOPE,
    }),
  });
  const json = (await readJson(response)) as RawTokenResponse;

  if (!response.ok) {
    const error = typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
    const detail =
      typeof json.error_description === 'string' && json.error_description.length > 0
        ? `: ${json.error_description}`
        : '';
    throw new AuthRequiredError(`Token refresh failed (${error}${detail}). Run \`asr login\`.`);
  }

  const accessToken = requiredString(json.access_token, 'access_token');
  const expiresInSeconds = positiveNumber(json.expires_in, 3600);
  const refreshToken =
    typeof json.refresh_token === 'string' && json.refresh_token.length > 0
      ? json.refresh_token
      : current.refreshToken;

  const refreshed: StoredTokens = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    account: accountFromAccessToken(accessToken, current.account),
  };

  await storeTokens(refreshed);
  return refreshed;
}

export async function getValidAccessToken(
  baseUrl: string,
  opts: GetValidAccessTokenOptions = {}
): Promise<string> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    throw new AuthRequiredError();
  }

  if (tokens.expiresAt - Date.now() > REFRESH_SAFETY_WINDOW_MS) {
    return tokens.accessToken;
  }

  const fetchImpl = opts.fetch ?? fetch;
  const refreshed = await refreshTokens(baseUrl, tokens, fetchImpl);
  return refreshed.accessToken;
}
