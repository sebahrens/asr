import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EmitAuditInput } from '../audit/emit.js';
import { createWebhookRoutes } from './webhooks.js';

describe('POST /webhooks/forgejo', () => {
  it('accepts a valid Forgejo signature and emits an audit event', async () => {
    const audit = vi.fn<(input: EmitAuditInput) => void>();
    const app = createWebhookRoutes({ secret: 'secret', audit });
    const body = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 42,
        head: { ref: 'submit/sub-1' },
      },
    });

    const res = await app.request('/forgejo', {
      method: 'POST',
      headers: {
        'X-Gitea-Signature': sign(body, 'secret'),
        'X-Gitea-Event': 'pull_request',
      },
      body,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(audit).toHaveBeenCalledWith({
      action: 'workflow.pushed_to_forgejo',
      submissionId: 'sub-1',
      actor: 'forgejo',
      actorType: 'system',
      detail: {
        event: 'pull_request',
        action: 'opened',
        prNumber: '42',
        submissionId: 'sub-1',
      },
    });
  });

  it('accepts the Forgejo signature header with sha256 prefix', async () => {
    const app = createWebhookRoutes({ secret: 'secret', audit: () => {} });
    const body = '{}';

    const res = await app.request('/forgejo', {
      method: 'POST',
      headers: {
        'X-Forgejo-Signature': `sha256=${sign(body, 'secret')}`,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it('rejects a missing signature', async () => {
    const app = createWebhookRoutes({ secret: 'secret' });
    const res = await app.request('/forgejo', { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: 'authentication_required',
    });
  });

  it('rejects an invalid signature', async () => {
    const app = createWebhookRoutes({ secret: 'secret' });
    const res = await app.request('/forgejo', {
      method: 'POST',
      headers: { 'X-Gitea-Signature': sign('{}', 'wrong-secret') },
      body: '{}',
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: 'authentication_required',
    });
  });
});

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
