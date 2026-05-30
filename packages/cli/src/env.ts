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
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function isPlaintextRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && !isAuthDisabled(url);
  } catch {
    return false;
  }
}
