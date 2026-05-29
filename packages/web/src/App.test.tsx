import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowseRegistry, SessionProvider } from './App';
import { BrandProvider } from './branding/BrandProvider';

interface MockSkill {
  owner: string;
  name: string;
  description: string;
  tags: string[];
  kind: 'instructions';
  latestVersion: string;
  riskAssessmentLatest: 'low' | 'medium' | 'high';
  downloadCount: number;
  publishedAt: string;
}

const skills: MockSkill[] = [
  {
    owner: 'platform',
    name: 'release-notes',
    description: 'Drafts concise release notes from merged pull requests.',
    tags: ['release', 'docs'],
    kind: 'instructions',
    latestVersion: '0.8.2',
    riskAssessmentLatest: 'low',
    downloadCount: 42,
    publishedAt: '2026-05-20T10:00:00Z',
  },
  {
    owner: 'security',
    name: 'secure-review',
    description: 'Compliance-grade dependency review workflow.',
    tags: ['security', 'compliance'],
    kind: 'instructions',
    latestVersion: '1.2.0',
    riskAssessmentLatest: 'medium',
    downloadCount: 18,
    publishedAt: '2026-05-19T10:00:00Z',
  },
];

function makeFetchStub(items: MockSkill[]): typeof fetch {
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  })) as unknown as typeof fetch;
}

function renderBrowse() {
  return render(
    <SessionProvider>
      <BrandProvider>
        <BrowseRegistry />
      </BrandProvider>
    </SessionProvider>,
  );
}

describe('BrowseRegistry empty state (asr-4e0)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetchStub(skills));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('shows a clear-filters action when a search yields no results', async () => {
    renderBrowse();

    expect(await screen.findByText('release-notes')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/search agent skills/i);
    fireEvent.change(searchInput, { target: { value: 'zzz-no-match-xyz' } });

    expect(await screen.findByText(/no skills match your search/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear search and filters/i })).toBeInTheDocument();
  });

  it('clears search and filters when the clear button is clicked', async () => {
    renderBrowse();

    expect(await screen.findByText('release-notes')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/search agent skills/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'zzz-no-match-xyz' } });

    const clearButton = await screen.findByRole('button', { name: /clear search and filters/i });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(searchInput.value).toBe('');
    });
    expect(screen.getByText('release-notes')).toBeInTheDocument();
    expect(screen.getByText('secure-review')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear search and filters/i })).not.toBeInTheDocument();
  });

  it('does not show the clear button when no filters are active and the registry is genuinely empty', async () => {
    vi.stubGlobal('fetch', makeFetchStub([]));

    renderBrowse();

    expect(await screen.findByText(/no skills are available yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear search and filters/i })).not.toBeInTheDocument();
  });
});
