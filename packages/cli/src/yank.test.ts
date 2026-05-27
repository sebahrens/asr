import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runYank, type YankPostResult } from './yank.js';

type PostFn = (
  path: string,
  body: unknown,
  token?: string,
) => Promise<YankPostResult>;

describe('runYank', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function stdout(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  function stderr(): string {
    return errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  it('returns 0 and prints "yanked <ref>" on 201', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({
      status: 201,
      body: { yanked: true, blocked_hash: 'sha256:ab' },
    }));

    const code = await runYank(
      { postRegistry, token: 't' },
      'acme/x@1.0.0',
      'leak',
    );

    expect(code).toBe(0);
    expect(stdout()).toContain('yanked acme/x@1.0.0');
    expect(postRegistry).toHaveBeenCalledTimes(1);
  });

  it('returns 1 and prints compliance-only message on 403', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({
      status: 403,
      body: { error: 'insufficient_permissions' },
    }));

    const code = await runYank(
      { postRegistry, token: 't' },
      'acme/x@1.0.0',
      'leak',
    );

    expect(code).toBe(1);
    expect(stderr()).toContain('compliance only');
  });

  it('returns 1 without calling postRegistry when reason is empty', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({ status: 201, body: {} }));

    const code = await runYank(
      { postRegistry, token: 't' },
      'acme/x@1.0.0',
      '',
    );

    expect(code).toBe(1);
    expect(postRegistry).not.toHaveBeenCalled();
    expect(stderr()).toContain('--reason is required');
  });

  it('POSTs the correct path, body, and token', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({
      status: 201,
      body: { yanked: true },
    }));

    await runYank(
      { postRegistry, token: 'tok-42' },
      'acme/x@1.0.0',
      'leak',
      'critical',
    );

    expect(postRegistry).toHaveBeenCalledTimes(1);
    const [path, body, token] = postRegistry.mock.calls[0];
    expect(path).toBe('/skills/acme/x/versions/1.0.0/yank');
    expect(body).toEqual({ reason: 'leak', severity: 'critical' });
    expect(token).toBe('tok-42');
  });

  it('defaults severity to "high" when not provided', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({
      status: 201,
      body: { yanked: true },
    }));

    await runYank(
      { postRegistry, token: 't' },
      'acme/x@1.0.0',
      'leak',
    );

    const [, body] = postRegistry.mock.calls[0];
    expect(body).toEqual({ reason: 'leak', severity: 'high' });
  });

  it('returns 1 with the error body on non-201/403 responses', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({
      status: 409,
      body: { error: 'version_yanked' },
    }));

    const code = await runYank(
      { postRegistry, token: 't' },
      'acme/x@1.0.0',
      'leak',
    );

    expect(code).toBe(1);
    expect(stderr()).toContain('409');
    expect(stderr()).toContain('version_yanked');
  });

  it('returns 1 for malformed ref before calling postRegistry', async () => {
    const postRegistry = vi.fn<PostFn>(async () => ({ status: 201, body: {} }));

    const code = await runYank(
      { postRegistry, token: 't' },
      'not-a-ref',
      'leak',
    );

    expect(code).toBe(1);
    expect(postRegistry).not.toHaveBeenCalled();
    expect(stderr()).toContain('Invalid ref');
  });
});
