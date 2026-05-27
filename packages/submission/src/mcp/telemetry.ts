import { pino } from 'pino';

export interface InvocationLog {
  traceId: string;
  sessionId: string;
  principalSub: string;
  tool: string;
  durationMs: number;
  outcome: 'ok' | 'error';
  code?: number;
}

export interface InvocationLogger {
  info(obj: Record<string, unknown>): void;
}

export const baseLogger: InvocationLogger = pino({ name: 'asr-mcp' });

/**
 * Emit exactly one structured log line per MCP tool invocation.
 *
 * The function intentionally accepts no tool inputs, outputs, results, error
 * messages, stacks, or exception objects — passing skill content through here
 * is impossible by signature, which enforces the no-leak guarantee in
 * specs/mcp.md#telemetry.
 *
 * Success records contain exactly: traceId, sessionId, principalSub, tool,
 * durationMs, outcome. Error records additionally carry the numeric MCP error
 * `code` and nothing else.
 */
export function logInvocation(log: InvocationLog, logger: InvocationLogger = baseLogger): void {
  const record: Record<string, unknown> = {
    traceId: log.traceId,
    sessionId: log.sessionId,
    principalSub: log.principalSub,
    tool: log.tool,
    durationMs: log.durationMs,
    outcome: log.outcome,
  };
  if (log.outcome === 'error' && typeof log.code === 'number') {
    record.code = log.code;
  }
  logger.info(record);
}
