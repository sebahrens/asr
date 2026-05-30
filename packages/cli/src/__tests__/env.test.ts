import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl, isAuthDisabled, isPlaintextRemoteUrl } from '../env.js';

const state = vi.hoisted(() => ({
  config: {} as { registry?: string },
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => state.config),
}));

describe('environment helpers', () => {
  const originalAsrUrl = process.env.ASR_URL;

  afterEach(() => {
    state.config = {};

    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
  });

  it('disables auth only for local HTTP URLs', () => {
    expect(isAuthDisabled('http://localhost:3001')).toBe(true);
    expect(isAuthDisabled('http://127.0.0.1:3001')).toBe(true);
    expect(isAuthDisabled('http://[::1]:3001')).toBe(true);
    expect(isAuthDisabled('http://prod-asr.example.com')).toBe(false);
    expect(isAuthDisabled('ftp://asr.example.com')).toBe(false);
  });

  it('keeps auth enabled for HTTPS URLs', () => {
    expect(isAuthDisabled('https://asr.example.com')).toBe(false);
  });

  it('identifies plaintext remote HTTP URLs for warnings', () => {
    expect(isPlaintextRemoteUrl('http://prod-asr.example.com')).toBe(true);
    expect(isPlaintextRemoteUrl('http://localhost:3001')).toBe(false);
    expect(isPlaintextRemoteUrl('https://prod-asr.example.com')).toBe(false);
  });

  it('returns ASR_URL before config registry', () => {
    process.env.ASR_URL = 'http://localhost:3001';
    state.config = { registry: 'https://registry.example.com' };

    expect(getApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('falls back to configured registry', () => {
    delete process.env.ASR_URL;
    state.config = { registry: 'https://registry.example.com' };

    expect(getApiBaseUrl()).toBe('https://registry.example.com');
  });

  it('throws a clear error when no API URL is configured', () => {
    delete process.env.ASR_URL;

    expect(() => getApiBaseUrl()).toThrow(/Set ASR_URL/);
  });
});
