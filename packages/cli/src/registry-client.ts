import type { SkillDetail, SkillSummary, SkillVersion } from '@asr/core';
import { getConfig } from './config.js';

export interface RegistryFetchOptions {
  token?: string;
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

export async function registryFetch<T>(path: string, options: RegistryFetchOptions = {}): Promise<T> {
  const base = resolveBaseUrl();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new RegistryError(res.status, body);
  }

  return (await res.json()) as T;
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
