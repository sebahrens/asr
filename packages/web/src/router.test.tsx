import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const skillDetail = {
  owner: 'asr',
  name: 'security-review',
  latestVersion: '1.0.0',
  description: 'Review code for security issues.',
  tags: ['security', 'review'],
  kind: 'skill',
  publishedAt: '2026-05-25T12:00:00.000Z',
  downloadCount: 42,
  riskAssessmentLatest: 'low',
  manifestLatest: {
    name: 'security-review',
    version: '1.0.0',
    author: 'Platform Team',
    description: 'Review code for security issues.',
    tags: ['security', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  },
  skillMd: `---
name: security-review
version: 1.0.0
author: Platform Team
description: Review code for security issues.
tags: [security, review]
---

# Secure Review

| Check | Evidence |
| --- | --- |
| Secrets | scanner output |
`,
  versions: [
    {
      owner: 'asr',
      name: 'security-review',
      version: '1.0.0',
      contentHash: 'sha256:abc',
      publishedAt: '2026-05-25T12:00:00.000Z',
      publishedBy: 'submitter',
      approvedBy: 'reviewer',
      prNumber: 12,
      mergeCommit: 'abc123',
      yanked: false,
      riskAssessment: 'low',
    },
  ],
};

function renderRoute(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  window.history.pushState({}, '', initialEntry);
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input);
    const body = url.endsWith('/api/v1/skills/asr/security-review')
      ? skillDetail
      : { items: [] };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));

  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('router', () => {
  it('routes review through the approval dashboard queue', async () => {
    renderRoute('/review');

    expect(await screen.findByRole('heading', { name: /approval dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /secure-code-review/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /release-notes/i })).toBeInTheDocument();
    expect(screen.getAllByText(/pending review/i)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^approve$/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^reject$/i })).toHaveLength(2);
  });

  it('keeps the existing browse page on the index route', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { name: /agent skill registry/i })).toBeInTheDocument();
  });

  it('renders skill detail on direct non-root navigation', async () => {
    renderRoute('/skills/asr/security-review');

    expect(await screen.findByRole('heading', { name: /security-review/i })).toBeInTheDocument();
    expect(screen.getByText(/scanner output/i)).toBeInTheDocument();
  });

  it('renders the publish wizard on direct non-root navigation', () => {
    renderRoute('/publish');

    expect(screen.getByRole('heading', { name: /publish a skill/i })).toBeInTheDocument();
  });

  it('renders a graceful inline 404 for unknown skill routes', () => {
    renderRoute('/skills/does-not-exist');

    expect(screen.getByRole('heading', { name: /skill not found/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /registry route error/i })).not.toBeInTheDocument();
  });
});
