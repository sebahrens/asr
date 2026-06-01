import { describe, expect, it, vi } from 'vitest';
import {
  createBearerAuthenticatedFetch,
  withBearerAuthorization,
  type AuthenticatedFetch,
} from './authenticatedFetch';

describe('authenticated fetch', () => {
  it('adds a bearer Authorization header while preserving existing headers', () => {
    const init = withBearerAuthorization({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, 'access-token-1');

    const headers = init.headers as Headers;
    expect(init.method).toBe('POST');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer access-token-1');
  });

  it('acquires a token before sending a protected request', async () => {
    const baseFetch = vi.fn<AuthenticatedFetch>(async () => new Response('{}', { status: 200 }));
    const getAccessToken = vi.fn(async () => 'access-token-2');
    const authenticatedFetch = createBearerAuthenticatedFetch(getAccessToken, baseFetch);

    await authenticatedFetch('/api/v1/submissions', { method: 'GET' });

    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(baseFetch).toHaveBeenCalledWith(
      '/api/v1/submissions',
      expect.objectContaining({ method: 'GET' }),
    );
    const [, init] = baseFetch.mock.calls[0]!;
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer access-token-2');
  });
});
