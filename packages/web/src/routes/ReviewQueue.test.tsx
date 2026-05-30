import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue, type PendingSubmissionRow } from './ReviewQueue';

function makeSubmission(overrides: PendingSubmissionRow): PendingSubmissionRow {
  return { ...overrides };
}

function renderQueue() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ReviewQueue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewQueue', () => {
  it('renders one row per pending submission with name, version, and detail link', async () => {
    const submissions: PendingSubmissionRow[] = [
      makeSubmission({ id: 'sub-A', skillName: 'secure-code-review', version: '1.4.0' }),
      makeSubmission({ id: 'sub-B', skillName: 'release-notes', version: '0.8.2' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ submissions }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    renderQueue();

    const rows = await screen.findAllByRole('row');
    // header row + 2 data rows
    expect(rows).toHaveLength(3);

    const firstLink = screen.getByRole('link', { name: 'secure-code-review' });
    expect(firstLink).toHaveAttribute('href', '/review/sub-A');
    expect(screen.getByText('1.4.0')).toBeInTheDocument();
    expect(screen.getAllByText('pending review')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Approve' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Reject' })).toHaveLength(2);

    const secondLink = screen.getByRole('link', { name: 'release-notes' });
    expect(secondLink).toHaveAttribute('href', '/review/sub-B');
    expect(screen.getByText('0.8.2')).toBeInTheDocument();
  });

  it('requests the canonical pending submissions API path', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ submissions: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    renderQueue();

    await screen.findByText('No submissions awaiting review');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/submissions?status=pending&limit=50');
  });

  it('keeps a large queue to a bounded rendered row window', async () => {
    const submissions: PendingSubmissionRow[] = Array.from({ length: 1000 }, (_, index) =>
      makeSubmission({
        id: `sub-${index}`,
        skillName: `skill-${index}`,
        version: '1.0.0',
      }),
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ submissions }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    renderQueue();

    expect(await screen.findByRole('link', { name: 'skill-0' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'skill-999' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeLessThan(30);
  });

  it('loads the next pending submissions page when one is available', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const submissions = url.includes('cursor=50')
        ? [makeSubmission({ id: 'sub-B', skillName: 'release-notes', version: '0.8.2' })]
        : [makeSubmission({ id: 'sub-A', skillName: 'secure-code-review', version: '1.4.0' })];

      return new Response(
        JSON.stringify({
          submissions,
          nextCursor: url.includes('cursor=50') ? null : '50',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderQueue();

    expect(await screen.findByRole('link', { name: 'secure-code-review' })).toBeInTheDocument();
    screen.getByRole('button', { name: /load more/i }).click();

    expect(await screen.findByRole('link', { name: 'release-notes' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/submissions?status=pending&limit=50&cursor=50');
  });

  it('renders status, risk, and finding metadata when the API includes it', async () => {
    const submissions: PendingSubmissionRow[] = [
      makeSubmission({
        id: 'sub-rich',
        skillName: 'secure-code-review',
        version: '1.4.0',
        status: { phase: 'compliance-review' },
        riskAssessment: 'high',
        findings: 2,
      }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ submissions }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    renderQueue();

    expect(await screen.findByText('compliance review')).toBeInTheDocument();
    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByText('2 findings')).toBeInTheDocument();
  });

  it('renders the empty state when no submissions are pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ submissions: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    renderQueue();

    await waitFor(() => {
      expect(screen.getByText('No submissions awaiting review')).toBeInTheDocument();
    });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a loading skeleton while the query is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {
      // never resolves — keep the query in the loading state
    })));

    renderQueue();

    expect(screen.getByRole('status', { name: /loading pending submissions/i })).toBeInTheDocument();
  });
});
