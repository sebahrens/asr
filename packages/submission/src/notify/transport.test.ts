import { describe, expect, it } from 'vitest';
import { InMemoryTransport, createTransport } from './transport.js';

describe('transport', () => {
  it('memory transport captures sent mail', async () => {
    const t = createTransport({ NOTIFY_TRANSPORT: 'memory' });
    expect(t).toBeInstanceOf(InMemoryTransport);

    await t.send({
      to: 'reviewer@example.com',
      subject: 'Scan needs review',
      body: 'Submission 01J… requires manual review.',
    });

    expect(t).toBeInstanceOf(InMemoryTransport);
    const sent = (t as InMemoryTransport).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      to: 'reviewer@example.com',
      subject: 'Scan needs review',
      body: 'Submission 01J… requires manual review.',
    });
  });

  it('defaults to in-memory transport when NOTIFY_TRANSPORT is unset', () => {
    expect(createTransport({})).toBeInstanceOf(InMemoryTransport);
  });

  it('returns a not-configured transport for smtp until prod wiring lands', async () => {
    const t = createTransport({ NOTIFY_TRANSPORT: 'smtp' });
    await expect(
      t.send({ to: 'x@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/not configured/);
  });

  it('returns a not-configured transport for graph until prod wiring lands', async () => {
    const t = createTransport({ NOTIFY_TRANSPORT: 'graph' });
    await expect(
      t.send({ to: 'x@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow(/not configured/);
  });
});
