import type { Submission } from '@asr/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type Session } from '../auth/SessionProvider';
import { DecisionPanel } from './DecisionPanel';

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 'sub-99',
    manifest: {
      name: 'example-skill',
      version: '2.1.0',
      author: 'team',
      description: 'desc',
      tags: [],
      kind: 'skill',
      permissions: { network: false, filesystem: 'none', subprocess: false, environment: [] },
    },
    classification: 'md-only',
    contentHash: 'sha256:abc',
    submittedAt: '2026-05-23T12:00:00.000Z',
    submittedBy: 'user-submitter',
    status: { phase: 'compliance-review' },
    ...overrides,
  };
}

function renderPanel(opts: {
  submission?: Submission;
  session: Session;
  risk?: 'low' | 'medium' | 'high';
  queryClient?: QueryClient;
}) {
  const queryClient =
    opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={opts.session}>
        <DecisionPanel submission={opts.submission ?? makeSubmission()} risk={opts.risk ?? 'medium'} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DecisionPanel', () => {
  it('disables Approve and Reject when submitter sub equals reviewer sub (separation of duties)', () => {
    renderPanel({
      submission: makeSubmission({ submittedBy: 'same-user' }),
      session: { sub: 'same-user', name: 'Same User', roles: ['Compliance'] },
    });

    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
  });

  it('enables Approve when submitter and reviewer differ, but keeps Reject disabled until a reason is typed', () => {
    renderPanel({
      submission: makeSubmission({ submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    const approve = screen.getByRole('button', { name: /approve/i });
    const reject = screen.getByRole('button', { name: /reject/i });

    expect(approve).toBeEnabled();
    expect(reject).toBeDisabled();

    const reasonInput = screen.getByRole('textbox', { name: /reason/i });
    fireEvent.change(reasonInput, { target: { value: 'Contains insecure import that bypasses sandbox.' } });

    expect(reject).toBeEnabled();
  });

  it('posts to /api/v1/submissions/<id>/approve when Approve is confirmed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      submission: makeSubmission({ id: 'sub-42', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
      risk: 'high',
    });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    // Confirmation modal repeats version + risk
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2.1.0');
    expect(dialog).toHaveTextContent(/high/i);

    fireEvent.click(screen.getByRole('button', { name: /confirm approve/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/submissions/sub-42/approve',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('moves focus to the confirm button on open and restores focus to the trigger on close', async () => {
    renderPanel({
      submission: makeSubmission({ submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    const approve = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approve);

    const confirm = await screen.findByRole('button', { name: /confirm approve/i });
    await waitFor(() => {
      expect(confirm).toHaveFocus();
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(approve).toHaveFocus();
    });
  });

  it('closes the modal when Escape is pressed before submitting', async () => {
    renderPanel({
      submission: makeSubmission({ submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('traps Tab focus inside the modal', async () => {
    renderPanel({
      submission: makeSubmission({ submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    const reasonInput = screen.getByRole('textbox', { name: /reason/i });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    const confirm = await screen.findByRole('button', { name: /confirm approve/i });
    const cancel = screen.getByRole('button', { name: /cancel/i });
    await waitFor(() => {
      expect(confirm).toHaveFocus();
    });

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    expect(reasonInput).not.toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it('posts to /api/v1/submissions/<id>/reject with the reason body when Reject is confirmed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      submission: makeSubmission({ id: 'sub-77', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    const reasonInput = screen.getByRole('textbox', { name: /reason/i });
    fireEvent.change(reasonInput, { target: { value: 'High-severity finding unresolved.' } });

    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /confirm reject/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/submissions/sub-77/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'High-severity finding unresolved.' }),
        }),
      );
    });
  });

  it('invalidates the pending submissions query after a successful approve', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel({
      submission: makeSubmission({ id: 'sub-1', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
      queryClient,
    });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm approve/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['submissions', 'pending'] });
    });
  });

  it('does not send the reason to the approve endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      submission: makeSubmission({ id: 'sub-9', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    const reasonInput = screen.getByRole('textbox', { name: /reason/i });
    fireEvent.change(reasonInput, { target: { value: 'irrelevant text typed for reject but used approve' } });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm approve/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    const init = firstCall[1];
    const body = init?.body;
    if (body !== undefined && body !== null) {
      expect(String(body)).not.toContain('reason');
    }
  });

  it('keeps the modal open and renders a SoD-specific alert when approve fails separation of duties', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'separation_of_duties_violation' }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      submission: makeSubmission({ id: 'sub-sod', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    const confirm = await screen.findByRole('button', { name: /confirm approve/i });
    fireEvent.click(confirm);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Separation of duties: submitters cannot approve or reject their own submissions.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(confirm).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a success status and closes the modal when reject succeeds', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      submission: makeSubmission({ id: 'sub-ok', submittedBy: 'user-submitter' }),
      session: { sub: 'compliance-officer', name: 'CO', roles: ['Compliance'] },
    });

    fireEvent.change(screen.getByRole('textbox', { name: /reason/i }), {
      target: { value: 'Policy exception is not documented.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm reject/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('Submission rejected.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
