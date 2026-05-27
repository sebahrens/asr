import type { Buffer } from 'buffer';
import type { SkillManifest } from '@asr/core';
import type { FetchLike } from './auth/device-code.js';
import { getValidAccessToken } from './auth/session.js';
import { getApiBaseUrl, isAuthDisabled } from './env.js';

export interface ApiErrorBody {
  error?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody, message?: string) {
    const reason = typeof body.error === 'string' ? ` ${body.error}` : '';
    super(message ?? `API request failed: ${status}${reason}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  fetch?: FetchLike;
  baseUrl?: string;
}

export interface PostSubmissionResponse {
  id: string;
  status: { phase: 'uploaded' };
  manifest: SkillManifest;
  contentHash: string;
  createdAt: string;
}

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<T> {
  const baseUrl = normalizeBase(opts.baseUrl ?? getApiBaseUrl());
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const headers: Record<string, string> = { ...opts.headers };
  if (!hasHeader(headers, 'Accept')) {
    headers.Accept = 'application/json';
  }

  if (!isAuthDisabled(baseUrl)) {
    const token = await getValidAccessToken(baseUrl, { fetch: opts.fetch });
    headers.Authorization = `Bearer ${token}`;
  }

  const fetchImpl = opts.fetch ?? fetch;
  const response = await fetchImpl(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
  });

  const text = await response.text();
  let body: ApiErrorBody;
  try {
    body = text ? (JSON.parse(text) as ApiErrorBody) : {};
  } catch {
    body = { error: text || undefined };
  }

  if (!response.ok) {
    throw new ApiError(response.status, body);
  }

  return body as T;
}

export interface PostSubmissionOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export async function postSubmission(
  zipBuffer: Buffer,
  filename: string,
  opts: PostSubmissionOptions = {}
): Promise<PostSubmissionResponse> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(zipBuffer)], { type: 'application/zip' });
  form.append('file', blob, filename);

  return apiFetch<PostSubmissionResponse>('/api/v1/submissions', {
    method: 'POST',
    body: form,
    fetch: opts.fetch,
    baseUrl: opts.baseUrl,
  });
}
