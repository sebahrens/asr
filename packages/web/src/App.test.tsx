import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '@asr/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowseRegistry, SessionProvider } from './App';
import { BrandProvider } from './branding/BrandProvider';

const skills = [
  {
    owner: 'platform',
    name: 'release-notes',
    description: 'Drafts concise release notes from merged pull requests.',
    tags: ['release', 'docs'],
    kind: 'skill',
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
    kind: 'skill',
    latestVersion: '1.2.0',
    riskAssessmentLatest: 'medium',
    downloadCount: 18,
    publishedAt: '2026-05-19T10:00:00Z',
  },
] satisfies SkillSummary[];

function makeFetchStub(items: readonly SkillSummary[]): typeof fetch {
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  })) as unknown as typeof fetch;
}

function renderBrowse() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrandProvider>
          <BrowseRegistry />
        </BrandProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('BrowseRegistry empty state (asr-4e0)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetchStub(skills));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
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

  it('renders product branding even when an old brand preference exists', async () => {
    window.localStorage.setItem('asr.brand', 'pwc');

    const { container } = renderBrowse();

    expect(await screen.findByRole('heading', { level: 1, name: 'Agent Skill Repository' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Agent Skill Repository' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch brand/i })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/PwC|Agent Skill Registry|Skill Registry/);
  });
});

describe('BrowseRegistry core type drift guard (asr-eau0)', () => {
  it('uses canonical SkillSummary fixtures for browse responses', () => {
    const driftGuard: readonly SkillSummary[] = skills;

    expect(driftGuard).toHaveLength(2);
  });
});

describe('BrowseRegistry skill card tags (asr-d5yj)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetchStub(skills));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('keeps tag buttons outside skill detail links', async () => {
    const { container } = renderBrowse();

    expect(await screen.findByText('release-notes')).toBeInTheDocument();

    const cardLinks = container.querySelectorAll<HTMLAnchorElement>('.skill-card a[href]');
    expect(cardLinks.length).toBeGreaterThan(0);
    for (const link of cardLinks) {
      expect(link.querySelector('button, [role="button"]')).toBeNull();
    }

    const cardTag = container.querySelector<HTMLButtonElement>('.skill-card .tag-action');
    expect(cardTag?.tagName).toBe('BUTTON');
  });

  it('filters the browse list when a card tag button is activated', async () => {
    const { container } = renderBrowse();

    expect(await screen.findByText('release-notes')).toBeInTheDocument();

    const releaseCard = screen.getByRole('link', { name: /open platform\/release-notes details/i }).closest('.skill-card');
    const releaseTag = releaseCard?.querySelector<HTMLButtonElement>('button.tag-action');
    expect(releaseTag).toBeTruthy();

    fireEvent.click(releaseTag!);

    await waitFor(() => {
      expect(screen.queryByText('secure-review')).not.toBeInTheDocument();
    });
    expect(screen.getByText('release-notes')).toBeInTheDocument();
    expect(container.querySelector('.skill-card a[href] button')).toBeNull();
  });
});
