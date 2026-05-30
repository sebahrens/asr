import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { emitAudit, type EmitAuditInput } from '../audit/emit.js';
import { apiError } from './errors.js';

export interface WebhookRouteOptions {
  db?: Database.Database;
  secret?: string;
  audit?: (input: EmitAuditInput) => void | Promise<void>;
}

export function createWebhookRoutes(options: WebhookRouteOptions = {}) {
  const routes = new Hono();

  routes.post('/forgejo', async (c) => {
    const body = Buffer.from(await c.req.arrayBuffer());
    const secret = options.secret ?? process.env.FORGEJO_WEBHOOK_SECRET;
    if (!secret) {
      return apiError(c, 503, 'internal_error', {
        message: 'FORGEJO_WEBHOOK_SECRET is required',
      });
    }

    const signature =
      c.req.header('X-Forgejo-Signature') ?? c.req.header('X-Gitea-Signature');
    if (!signature || !verifySignature(body, secret, signature)) {
      return apiError(c, 401, 'authentication_required', {
        message: 'invalid Forgejo webhook signature',
      });
    }

    let payload: unknown;
    try {
      payload = body.length ? JSON.parse(body.toString('utf8')) : {};
    } catch {
      return apiError(c, 400, 'invalid_manifest', {
        message: 'webhook payload must be JSON',
      });
    }

    const event = c.req.header('X-Forgejo-Event') ?? c.req.header('X-Gitea-Event') ?? 'unknown';
    await emitWebhookAudit(options, event, payload);

    return c.json({ ok: true });
  });

  return routes;
}

function verifySignature(body: Buffer, secret: string, signature: string): boolean {
  const normalized = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(normalized, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function emitWebhookAudit(
  options: WebhookRouteOptions,
  event: string,
  payload: unknown,
): Promise<void> {
  const detail = webhookAuditDetail(event, payload);
  const input: EmitAuditInput = {
    action: 'workflow.pushed_to_forgejo',
    submissionId: detail.submissionId ?? null,
    actor: 'forgejo',
    actorType: 'system',
    detail,
  };

  if (options.audit) {
    await options.audit(input);
    return;
  }
  if (options.db) {
    emitAudit(options.db, input);
  }
}

function webhookAuditDetail(
  event: string,
  payload: unknown,
): { event: string; action?: string; prNumber?: string; submissionId?: string } {
  if (!isRecord(payload)) {
    return { event };
  }

  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : undefined;
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const prNumber =
    typeof pullRequest?.number === 'number'
      ? String(pullRequest.number)
      : typeof payload.number === 'number'
        ? String(payload.number)
        : undefined;
  const branch = isRecord(pullRequest?.head) && typeof pullRequest.head.ref === 'string'
    ? pullRequest.head.ref
    : undefined;
  const submissionId = branch?.startsWith('submit/') ? branch.slice('submit/'.length) : undefined;

  return {
    event,
    ...(action ? { action } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(submissionId ? { submissionId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
