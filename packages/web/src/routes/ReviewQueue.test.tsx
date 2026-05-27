import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Submission } from '@asr/core';
import { ReviewQueue } from './ReviewQueue';

function makeSubmission(overrides: Partial<Submission> & { id: string; name: string; version: string }): Submission {
  const { id, name, version, ...rest } = overrides;
  return {
    id,
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt: '2026-05-26T08:30:00.000Z',
    submittedBy: 'submitter',
    status: { phase: 'compliance-review' },
    manifest: {
      name,
      version,
      author: 'Platform Team',
      description: `Manifest for ${name}.`,
      tags: ['security'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    },
    ...rest,
  };
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
    const submissions: Submission[] = [
      makeSubmission({ id: 'sub-A', name: 'secure-code-review', version: '1.4.0' }),
      makeSubmission({ id: 'sub-B', name: 'release-notes', version: '0.8.2' }),
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

    const secondLink = screen.getByRole('link', { name: 'release-notes' });
    expect(secondLink).toHaveAttribute('href', '/review/sub-B');
    expect(screen.getByText('0.8.2')).toBeInTheDocument();
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
