import type { SkillDetail, SkillSummary, SkillVersion } from '@asr/core';
import { getConfig } from './config.js';

export interface RegistryFetchOptions {
  token?: string;
  method?: string;
  body?: unknown;
}

export interface SearchSkillsOptions {
  tag?: string | string[];
  kind?: 'skill' | 'persona';
  limit?: number;
  cursor?: string;
}

export interface SearchSkillsResult {
  items: SkillSummary[];
  nextCursor?: string;
}

export class RegistryError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `Registry request failed: ${status} ${body}`);
    this.name = 'RegistryError';
    this.status = status;
    this.body = body;
  }
}

function resolveBaseUrl(): string {
  const envUrl = process.env.ASR_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');

  const config = getConfig();
  if (config.registry) return config.registry.replace(/\/$/, '');

  throw new Error('No ASR API URL configured. Set ASR_URL or run: asr config set registry <url>');
}

export interface RegistryResponse<T> {
  status: number;
  body: T;
}

export async function registryRequest<T>(
  path: string,
  options: RegistryFetchOptions = {},
): Promise<RegistryResponse<T>> {
  const base = resolveBaseUrl();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RegistryError(res.status, text);
  }

  const body = (text ? JSON.parse(text) : {}) as T;
  return { status: res.status, body };
}

export async function registryFetch<T>(path: string, options: RegistryFetchOptions = {}): Promise<T> {
  const { body } = await registryRequest<T>(path, options);
  return body;
}

export async function searchSkills(
  q: string,
  opts: SearchSkillsOptions = {},
  fetchOptions: RegistryFetchOptions = {}
): Promise<SearchSkillsResult> {
  const params = new URLSearchParams();
  if (q) params.append('q', q);
  if (opts.tag) {
    const tags = Array.isArray(opts.tag) ? opts.tag : [opts.tag];
    for (const tag of tags) params.append('tag', tag);
  }
  if (opts.kind) params.append('kind', opts.kind);
  if (opts.limit !== undefined) params.append('limit', String(opts.limit));
  if (opts.cursor) params.append('cursor', opts.cursor);

  const query = params.toString();
  const path = `/api/v1/skills${query ? `?${query}` : ''}`;
  return registryFetch<SearchSkillsResult>(path, fetchOptions);
}

export async function getSkillDetail(
  owner: string,
  name: string,
  fetchOptions: RegistryFetchOptions = {}
): Promise<SkillDetail> {
  return registryFetch<SkillDetail>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    fetchOptions
  );
}

export async function listVersions(
  owner: string,
  name: string,
  fetchOptions: RegistryFetchOptions = {}
): Promise<SkillVersion[]> {
  return registryFetch<SkillVersion[]>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions`,
    fetchOptions
  );
}

export interface ResolvedDownload {
  url: string;
  yanked: boolean;
}

export async function resolveDownload(
  owner: string,
  name: string,
  version: string,
  fetchOptions: RegistryFetchOptions = {}
): Promise<ResolvedDownload> {
  const base = resolveBaseUrl();
  const path = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}/download`;
  const url = `${base}${path}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (fetchOptions.token) headers.Authorization = `Bearer ${fetchOptions.token}`;

  const res = await fetch(url, { headers, redirect: 'manual' });

  if (res.status < 300 || res.status >= 400) {
    const body = await res.text().catch(() => '');
    throw new RegistryError(res.status, body, `expected 3xx redirect, got ${res.status}`);
  }

  const location = res.headers.get('Location');
  if (!location) {
    throw new RegistryError(res.status, '', `redirect ${res.status} missing Location header`);
  }

  const yanked = res.headers.get('X-ASR-Yanked') === 'true';
  return { url: location, yanked };
}
