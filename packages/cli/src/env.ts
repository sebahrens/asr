import { getConfig } from './config.js';

export function getApiBaseUrl(): string {
  const envUrl = process.env.ASR_URL;
  if (envUrl) return envUrl;

  const config = getConfig();
  if (config.registry) return config.registry;

  throw new Error('No ASR API URL configured. Set ASR_URL or run: asr config set registry <url>');
}

export function isAuthDisabled(url: string): boolean {
  try {
    return new URL(url).protocol !== 'https:';
  } catch {
    return false;
  }
}
