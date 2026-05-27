import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { logInvocation, type InvocationLogger } from './telemetry.js';

function makeCapturingLogger(): { logger: InvocationLogger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write(chunk: string) {
        records.push(JSON.parse(chunk));
      },
    },
  );
  return { logger, records };
}

describe('logInvocation', () => {
  it('writes exactly the six telemetry fields on success', () => {
    const { logger, records } = makeCapturingLogger();

    logInvocation(
      {
        traceId: 't-1',
        sessionId: 's-1',
        principalSub: 'sub-123',
        tool: 'asr.search',
        durationMs: 42,
        outcome: 'ok',
      },
      logger,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;

    const payloadKeys = Object.keys(record).filter(
      (k) => !['level', 'time', 'pid', 'hostname', 'name', 'v', 'msg'].includes(k),
    );
    expect(new Set(payloadKeys)).toEqual(
      new Set(['traceId', 'sessionId', 'principalSub', 'tool', 'durationMs', 'outcome']),
    );

    expect(record.traceId).toBe('t-1');
    expect(record.sessionId).toBe('s-1');
    expect(record.principalSub).toBe('sub-123');
    expect(record.tool).toBe('asr.search');
    expect(record.durationMs).toBe(42);
    expect(record.outcome).toBe('ok');
  });

  it('adds numeric code on error and never leaks stack/err/input/output/result', () => {
    const { logger, records } = makeCapturingLogger();

    logInvocation(
      {
        traceId: 't-2',
        sessionId: 's-2',
        principalSub: 'sub-456',
        tool: 'asr.info',
        durationMs: 7,
        outcome: 'error',
        code: -32004,
      },
      logger,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;

    expect(record.outcome).toBe('error');
    expect(record.code).toBe(-32004);

    for (const forbidden of ['stack', 'err', 'input', 'output', 'result']) {
      expect(record).not.toHaveProperty(forbidden);
    }
  });

  it('omits code on a success record', () => {
    const { logger, records } = makeCapturingLogger();

    logInvocation(
      {
        traceId: 't-3',
        sessionId: 's-3',
        principalSub: 'sub-789',
        tool: 'asr.versions',
        durationMs: 1,
        outcome: 'ok',
        code: 999,
      },
      logger,
    );

    expect(records[0]).not.toHaveProperty('code');
  });
});
