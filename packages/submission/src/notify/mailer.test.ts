import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from './transport.js';
import { notify } from './mailer.js';
import { render, type NotifyEvent } from './templates.js';

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const EVENTS: NotifyEvent[] = [
  'questionnaire_ready',
  'scan_review_required',
  'approved',
  'rejected',
  'sla_extended',
  'sla_escalated',
];

describe('mailer', () => {
  it('review email carries the link and only the reviewer address', async () => {
    const mem = new InMemoryTransport();

    await notify(mem, 'reviewer@example.com', 'scan_review_required', {
      submissionId: 's_1',
      baseUrl: 'https://asr.example',
    });

    expect(mem.sent).toHaveLength(1);
    const msg = mem.sent[0];
    expect(msg.to).toBe('reviewer@example.com');
    expect(msg.body).toContain('https://asr.example/submissions/s_1');

    const addresses = msg.body.match(EMAIL_RE) ?? [];
    for (const addr of addresses) {
      expect(addr).toBe('reviewer@example.com');
    }
  });

  it('renders a distinct subject for every event', () => {
    const subjects = new Set(
      EVENTS.map(
        (e) => render(e, { submissionId: 's_1', baseUrl: 'https://asr.example' }).subject,
      ),
    );
    expect(subjects.size).toBe(EVENTS.length);
  });

  it('every event body embeds the deep link and no other addresses', () => {
    for (const event of EVENTS) {
      const { body } = render(event, {
        submissionId: 'sub_abc',
        baseUrl: 'https://asr.example',
      });
      expect(body).toContain('https://asr.example/submissions/sub_abc');
      expect(body.match(EMAIL_RE) ?? []).toEqual([]);
    }
  });

  it('strips a trailing slash from baseUrl when building the link', () => {
    const { body } = render('approved', {
      submissionId: 's_2',
      baseUrl: 'https://asr.example/',
    });
    expect(body).toContain('https://asr.example/submissions/s_2');
    expect(body).not.toContain('https://asr.example//submissions/s_2');
  });

  it('sends to exactly one recipient per notify call', async () => {
    const mem = new InMemoryTransport();
    await notify(mem, 'submitter@example.com', 'approved', {
      submissionId: 's_3',
      baseUrl: 'https://asr.example',
    });
    await notify(mem, 'reviewer@example.com', 'scan_review_required', {
      submissionId: 's_3',
      baseUrl: 'https://asr.example',
    });

    expect(mem.sent).toHaveLength(2);
    expect(mem.sent[0].to).toBe('submitter@example.com');
    expect(mem.sent[1].to).toBe('reviewer@example.com');
    expect(mem.sent[0].body).not.toContain('reviewer@example.com');
    expect(mem.sent[1].body).not.toContain('submitter@example.com');
  });
});
