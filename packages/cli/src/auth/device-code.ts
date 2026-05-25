import { Buffer } from 'buffer';
import type { StoredTokens } from './token-store.js';

export interface DeviceCodeResponse {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  interval: number;
}

export interface PollForTokenOptions {
  fetch?: FetchLike;
  initialIntervalSeconds?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RawDeviceCodeResponse {
  verification_uri?: unknown;
  verification_url?: unknown;
  user_code?: unknown;
  device_code?: unknown;
  interval?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
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

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_POLL_TIMEOUT_SECONDS = 900;
const MAX_POLL_INTERVAL_SECONDS = 30;

function endpoint(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalized);
}

function numericEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(`Device code response missing ${field}`);
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

function accessTokenClaims(accessToken: string): TokenClaims {
  const [, encodedPayload] = accessToken.split('.');
  if (!encodedPayload) return {};

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return {};
  }
}

function accountFromAccessToken(accessToken: string): string {
  const claims = accessTokenClaims(accessToken);
  return (
    claims.preferred_username ??
    claims.upn ??
    claims.email ??
    claims.name ??
    claims.sub ??
    'unknown'
  );
}

function errorMessage(error: string, description: unknown): string {
  const detail = typeof description === 'string' && description.length > 0 ? `: ${description}` : '';
  return `${error}${detail}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('Device code polling aborted'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Device code polling aborted'));
      },
      { once: true }
    );
  });
}

export async function requestDeviceCode(
  baseUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<DeviceCodeResponse> {
  const response = await fetchImpl(endpoint(baseUrl, 'devicecode'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: requestBody({
      client_id: process.env.ASR_ENTRA_CLIENT_ID,
      scope: process.env.ASR_ENTRA_SCOPE,
    }),
  });
  const json = (await readJson(response)) as RawDeviceCodeResponse;

  if (!response.ok) {
    const error = typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
    throw new Error(`Device code request failed: ${errorMessage(error, json.error_description)}`);
  }

  return {
    verificationUri: requiredString(json.verification_uri ?? json.verification_url, 'verification_uri'),
    userCode: requiredString(json.user_code, 'user_code'),
    deviceCode: requiredString(json.device_code, 'device_code'),
    interval: positiveNumber(json.interval, DEFAULT_POLL_INTERVAL_SECONDS),
  };
}

export async function pollForToken(
  baseUrl: string,
  deviceCode: string,
  opts: PollForTokenOptions = {}
): Promise<StoredTokens> {
  const fetchImpl = opts.fetch ?? fetch;
  let intervalSeconds = Math.min(
    positiveNumber(
      opts.initialIntervalSeconds,
      numericEnv('ASR_DEVICE_POLL_INTERVAL_SECONDS', DEFAULT_POLL_INTERVAL_SECONDS)
    ),
    MAX_POLL_INTERVAL_SECONDS
  );
  const timeoutSeconds = positiveNumber(
    opts.timeoutSeconds,
    numericEnv('ASR_DEVICE_POLL_TIMEOUT_SECONDS', DEFAULT_POLL_TIMEOUT_SECONDS)
  );
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const response = await fetchImpl(endpoint(baseUrl, 'token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: requestBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: process.env.ASR_ENTRA_CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: opts.signal,
    });
    const json = (await readJson(response)) as RawTokenResponse;

    if (response.ok) {
      const accessToken = requiredString(json.access_token, 'access_token');
      const expiresInSeconds = positiveNumber(json.expires_in, 3600);
      return {
        accessToken,
        refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
        expiresAt: Date.now() + expiresInSeconds * 1000,
        account: accountFromAccessToken(accessToken),
      };
    }

    const error = typeof json.error === 'string' ? json.error : `HTTP ${response.status}`;
    if (error === 'authorization_pending') {
      await sleep(intervalSeconds * 1000, opts.signal);
      continue;
    }

    if (error === 'slow_down') {
      intervalSeconds = Math.min(intervalSeconds * 2, MAX_POLL_INTERVAL_SECONDS);
      await sleep(intervalSeconds * 1000, opts.signal);
      continue;
    }

    if (error === 'access_denied' || error === 'expired_token') {
      throw new Error(`Device code authorization failed: ${errorMessage(error, json.error_description)}`);
    }

    throw new Error(`Device code token request failed: ${errorMessage(error, json.error_description)}`);
  }

  throw new Error(`Device code polling timed out after ${timeoutSeconds} seconds`);
}
