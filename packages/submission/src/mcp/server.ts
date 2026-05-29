import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Handler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Identity } from '../auth/types.js';
import type { Database } from '../db/index.js';
import { getDefaultRegistryDb } from '../http/registry.js';
import { resolveMcpPrincipal } from './auth.js';
import { MCP_ERROR, McpToolError, mcpError } from './errors.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';
import { baseLogger, logInvocation, type InvocationLogger } from './telemetry.js';
import { registerRegistryDownloadUrl } from './tools/registryDownloadUrl.js';
import { registerRegistryInfo } from './tools/registryInfo.js';
import { registerRegistryList } from './tools/registryList.js';
import { registerRegistrySearch } from './tools/registrySearch.js';
import { registerRegistryVersions } from './tools/registryVersions.js';
import {
  registerReviewDecision,
  type ReviewDecisionDeps,
} from './tools/reviewDecision.js';
import { registerReviewQueue } from './tools/reviewQueue.js';
import { registerSubmissionStatus } from './tools/submissionStatus.js';
import { registerSubmissionsMine } from './tools/submissionsMine.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_VERSION = '0.1.0';
const DEFAULT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  principal: Identity;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, McpSession>();
let nextSessionSweepAt = 0;

const defaultLimiter: RateLimiter = createRateLimiter();

export type ToolHandler<Args extends unknown[] = unknown[], R = unknown> = (
  ...args: Args
) => R | Promise<R>;

export interface WrapToolHandlerDeps {
  limiter: RateLimiter;
  logger: InvocationLogger;
  principalOf: (extra: unknown) => string;
  sessionOf: (extra: unknown) => string;
}

export function wrapToolHandler<Args extends unknown[], R>(
  tool: string,
  handler: ToolHandler<Args, R>,
  deps: WrapToolHandlerDeps,
): ToolHandler<Args, R> {
  return async (...args: Args): Promise<R> => {
    const extra = args[args.length - 1];
    const principalSub = deps.principalOf(extra);
    const sessionId = deps.sessionOf(extra);
    const traceId = randomUUID();

    const limit = deps.limiter.check(principalSub, tool);
    if (!limit.ok) {
      logInvocation(
        {
          traceId,
          sessionId,
          principalSub,
          tool,
          durationMs: 0,
          outcome: 'error',
          code: MCP_ERROR.rate_limited,
        },
        deps.logger,
      );
      throw new McpToolError(MCP_ERROR.rate_limited, 'rate_limited', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const startedAt = Date.now();
    let outcome: 'ok' | 'error' = 'ok';
    let code: number | undefined;
    try {
      return await handler(...args);
    } catch (err) {
      outcome = 'error';
      if (err instanceof McpToolError) {
        code = err.code;
      }
      throw err;
    } finally {
      const durationMs = Date.now() - startedAt;
      logInvocation(
        { traceId, sessionId, principalSub, tool, durationMs, outcome, code },
        deps.logger,
      );
    }
  };
}

function defaultPrincipalOf(extra: unknown): string {
  if (typeof extra !== 'object' || extra === null) return '';
  const authInfo = (extra as { authInfo?: { extra?: { principal?: Identity } } }).authInfo;
  return authInfo?.extra?.principal?.sub ?? '';
}

function defaultSessionOf(extra: unknown): string {
  if (typeof extra !== 'object' || extra === null) return '';
  return (extra as { sessionId?: string }).sessionId ?? '';
}

export interface CreateMcpServerOptions {
  limiter?: RateLimiter;
  logger?: InvocationLogger;
  db?: Database;
  reviewDecisionDeps?: ReviewDecisionDeps;
}

export function createMcpServer(opts: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'asr-registry',
    version: SERVER_VERSION,
  });
  const deps: WrapToolHandlerDeps = {
    limiter: opts.limiter ?? defaultLimiter,
    logger: opts.logger ?? baseLogger,
    principalOf: defaultPrincipalOf,
    sessionOf: defaultSessionOf,
  };
  // Eagerly initialise the tools/* request handlers so tools/list returns
  // an empty list before downstream tasks (asr-76e.x, asr-3hs.x) register
  // real tools. Disabled tools are filtered out of the listing. Route through
  // wrapToolHandler so every future tool inherits rate limiting + telemetry.
  server
    .tool('_noop', wrapToolHandler('_noop', () => ({ content: [] }), deps))
    .disable();
  if (opts.db) {
    registerRegistrySearch(server, opts.db, deps);
    registerRegistryList(server, opts.db, deps);
    registerRegistryInfo(server, opts.db, deps);
    registerRegistryVersions(server, opts.db, deps);
    registerRegistryDownloadUrl(server, opts.db, deps);
    registerReviewQueue(server, opts.db, deps);
    registerSubmissionsMine(server, opts.db, deps);
    registerSubmissionStatus(server, opts.db, deps);
    if (opts.reviewDecisionDeps) {
      registerReviewDecision(server, opts.db, opts.reviewDecisionDeps, deps);
    }
  }
  return server;
}

export interface McpRouteOptions {
  db?: Database;
  reviewDecisionDeps?: ReviewDecisionDeps;
  session?: Partial<McpSessionPolicy>;
}

interface McpSessionPolicy {
  idleTimeoutMs: number;
  maxAgeMs: number;
  maxSessions: number;
  now: () => number;
  sweepIntervalMs: number;
}

export function createMcpRoute(options: McpRouteOptions = {}): Handler {
  return async (c) => {
    const sessionPolicy = resolveSessionPolicy(options.session);
    if (c.req.method === 'GET') {
      const lookup = getActiveSession(c.req.header('mcp-session-id'), sessionPolicy);
      if (!lookup.session) {
        return lookup.expired ? sessionExpired(c, null) : sessionNotFound(c);
      }
      return lookup.session.transport.handleRequest(c.req.raw, {
        authInfo: authInfoFor(lookup.session.principal),
      });
    }

    if (c.req.method === 'DELETE') {
      const sessionId = c.req.header('mcp-session-id');
      const lookup = getActiveSession(sessionId, sessionPolicy);
      if (!lookup.session) {
        return lookup.expired ? sessionExpired(c, null) : sessionNotFound(c);
      }
      const response = await lookup.session.transport.handleRequest(c.req.raw, {
        authInfo: authInfoFor(lookup.session.principal),
      });
      if (response.ok && sessionId) {
        sessions.delete(sessionId);
      }
      return response;
    }

    if (c.req.method !== 'POST') {
      return c.json(jsonRpcError(-32000, 'Method not allowed', null), 405, {
        Allow: 'GET, POST, DELETE',
      });
    }

    const body = await readJson(c.req.raw);
    if (body === undefined) {
      return c.json(jsonRpcError(-32700, 'Parse error', null), 400);
    }

    const sessionId = c.req.header('mcp-session-id');
    if (sessionId) {
      const lookup = getActiveSession(sessionId, sessionPolicy);
      if (!lookup.session) {
        return lookup.expired
          ? sessionExpired(c, extractId(body))
          : c.json(jsonRpcError(-32000, 'MCP session not found', extractId(body)), 404);
      }
      return lookup.session.transport.handleRequest(c.req.raw, {
        parsedBody: body,
        authInfo: authInfoFor(lookup.session.principal),
      });
    }

    if (!isInitializeRequest(body)) {
      return c.json(jsonRpcError(-32000, 'MCP session not found', extractId(body)), 400);
    }

    let principal: Identity;
    try {
      principal = await resolveMcpPrincipal(c.req.raw);
    } catch (err) {
      if (err instanceof McpToolError) {
        return c.json(
          {
            jsonrpc: '2.0',
            error: mcpError(err.code, err.message, err.data),
            id: extractId(body),
          },
          401,
        );
      }
      throw err;
    }

    const transport = await createTransportForInitialize(principal, options, sessionPolicy);
    return transport.handleRequest(c.req.raw, {
      parsedBody: body,
      authInfo: authInfoFor(principal),
    });
  };
}

export const mcpHandler: Handler = createMcpRoute();

export function clearMcpSessionsForTest(): void {
  sessions.clear();
  nextSessionSweepAt = 0;
}

function getActiveSession(
  sessionId: string | undefined,
  policy: McpSessionPolicy,
): { expired: boolean; session?: McpSession } {
  if (!sessionId) {
    sweepExpiredSessions(policy);
    return { expired: false };
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sweepExpiredSessions(policy);
    return { expired: false };
  }
  const now = policy.now();
  if (isSessionExpired(session, now, policy)) {
    sessions.delete(sessionId);
    return { expired: true };
  }
  session.lastSeenAt = now;
  sweepExpiredSessions(policy);
  return { expired: false, session };
}

function sessionNotFound(c: Parameters<Handler>[0]): Response {
  return c.json(jsonRpcError(-32000, 'MCP session not found', null), 404);
}

function sessionExpired(c: Parameters<Handler>[0], id: string | number | null): Response {
  return c.json(
    {
      jsonrpc: '2.0',
      error: mcpError(MCP_ERROR.authentication_required, 'authentication_required'),
      id,
    },
    401,
  );
}

async function createTransportForInitialize(
  principal: Identity,
  options: McpRouteOptions = {},
  policy = resolveSessionPolicy(options.session),
): Promise<WebStandardStreamableHTTPServerTransport> {
  sweepExpiredSessions(policy);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(sessionId) {
      const now = policy.now();
      sessions.set(sessionId, {
        transport,
        principal,
        createdAt: now,
        expiresAt: sessionExpiresAt(principal, now, policy),
        lastSeenAt: now,
      });
      enforceSessionCap(policy);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const db = options.db ?? getDefaultRegistryDb();
  await createMcpServer({
    db,
    reviewDecisionDeps: options.reviewDecisionDeps,
  }).connect(transport);
  return transport;
}

function resolveSessionPolicy(overrides: Partial<McpSessionPolicy> = {}): McpSessionPolicy {
  return {
    idleTimeoutMs: overrides.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    maxAgeMs: overrides.maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS,
    maxSessions: overrides.maxSessions ?? DEFAULT_MAX_SESSIONS,
    now: overrides.now ?? Date.now,
    sweepIntervalMs: overrides.sweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  };
}

function sessionExpiresAt(principal: Identity, now: number, policy: McpSessionPolicy): number {
  const maxExpiresAt = now + policy.maxAgeMs;
  return typeof principal.tokenExpiresAt === 'number'
    ? Math.min(principal.tokenExpiresAt, maxExpiresAt)
    : maxExpiresAt;
}

function isSessionExpired(
  session: McpSession,
  now: number,
  policy: McpSessionPolicy,
): boolean {
  return now >= session.expiresAt || now - session.lastSeenAt >= policy.idleTimeoutMs;
}

function sweepExpiredSessions(policy: McpSessionPolicy): void {
  const now = policy.now();
  if (now < nextSessionSweepAt) {
    return;
  }
  nextSessionSweepAt = now + policy.sweepIntervalMs;
  for (const [sessionId, session] of sessions) {
    if (isSessionExpired(session, now, policy)) {
      sessions.delete(sessionId);
    }
  }
}

function enforceSessionCap(policy: McpSessionPolicy): void {
  if (sessions.size <= policy.maxSessions) {
    return;
  }
  const sessionsByLastSeen = [...sessions.entries()].sort(
    ([, a], [, b]) => a.lastSeenAt - b.lastSeenAt,
  );
  for (const [sessionId] of sessionsByLastSeen.slice(0, sessions.size - policy.maxSessions)) {
    sessions.delete(sessionId);
  }
}

function authInfoFor(principal: Identity): AuthInfo {
  return {
    token: '',
    clientId: '',
    scopes: principal.roles,
    extra: { principal },
  };
}

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'method' in body &&
    body.method === 'initialize'
  );
}

function extractId(body: unknown): string | number | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    (typeof (body as { id: unknown }).id === 'string' ||
      typeof (body as { id: unknown }).id === 'number')
  ) {
    return (body as { id: string | number }).id;
  }
  return null;
}

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function jsonRpcError(code: number, message: string, id: string | number | null) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id,
  };
}

export { MCP_PROTOCOL_VERSION };
