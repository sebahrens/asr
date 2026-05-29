import type { ScanReport, Submission, VersionDiff } from '@asr/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../auth/SessionProvider';
import { ReviewDetail } from './ReviewDetail';

const submission: Submission = {
  id: 'sub-test',
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
  submittedBy: 'user',
  status: { phase: 'compliance-review' },
};

const versionDiff: VersionDiff = {
  skillName: 'example-skill',
  fromVersion: '2.0.0',
  toVersion: '2.1.0',
  fromContentHash: 'sha256:prev',
  toContentHash: 'sha256:abc',
  filesAdded: [],
  filesRemoved: [],
  filesModified: ['SKILL.md'],
  dependenciesAdded: {},
  dependenciesRemoved: {},
  dependenciesChanged: {},
  permissionsBefore: { network: false, filesystem: 'none', subprocess: false, environment: [] },
  permissionsAfter: { network: true, filesystem: 'none', subprocess: false, environment: [] },
  permissionsExpanded: true,
  manifestKindChanged: false,
  riskAssessment: 'medium',
  computedAt: '2026-05-23T12:01:00.000Z',
};

const scanReport: ScanReport = {
  submissionId: 'sub-test',
  scanId: 'scan-1',
  contentHash: 'sha256:abc',
  scannerImage: 'asr-scanner:1.0',
  startedAt: '2026-05-23T12:00:30.000Z',
  completedAt: '2026-05-23T12:01:00.000Z',
  durationMs: 30000,
  verdict: 'review_required',
  findings: [{
    tool: 'opengrep',
    ruleId: 'unsafe-import',
    severity: 'high',
    file: 'SKILL.md',
    line: 12,
    message: 'High-severity issue found',
  }],
  toolResults: {
    gitleaks: { exitCode: 0, findingCount: 0 },
    trivy: { exitCode: 0, findingCount: 0 },
    foxguard: { exitCode: 0, findingCount: 0 },
    opengrep: { exitCode: 0, findingCount: 1 },
    veracode: { exitCode: 0, findingCount: 0, skipped: true },
  },
};

function renderRoute(id: string, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ sub: 'reviewer', name: 'Reviewer', roles: ['Compliance'] }}>
        <MemoryRouter initialEntries={[`/review/${id}`]}>
          <Routes>
            <Route path="/review/:id" element={<ReviewDetail />} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewDetail', () => {
  it('renders a review-queue-oriented not-found state when the submission API returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderRoute('does-not-exist');

    const heading = await screen.findByRole('heading', {
      name: /unable to load this submission|submission not found/i,
    });
    expect(heading).toBeInTheDocument();

    // Eyebrow must be review-oriented, not the generic "Skill lookup"
    expect(screen.getByText(/submission lookup/i)).toBeInTheDocument();
    expect(screen.queryByText(/skill lookup/i)).not.toBeInTheDocument();

    // Primary recovery action sends the reviewer back to the queue, not to skill browse
    const backLink = screen.getByRole('link', { name: /back to review queue/i });
    expect(backLink).toHaveAttribute('href', '/review');
    expect(screen.queryByRole('link', { name: /browse skills/i })).not.toBeInTheDocument();
  });

  it('does not get stuck in loading on 404 when retries are enabled (no retry on 4xx)', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    // Use a QueryClient that allows retries (mirrors production main.tsx).
    // retryDelay: 0 keeps the test fast if the fix regresses.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0 } },
    });

    renderRoute('does-not-exist', queryClient);

    const heading = await screen.findByRole('heading', {
      name: /unable to load this submission|submission not found/i,
    });
    expect(heading).toBeInTheDocument();

    // Each of the 3 queries (submission, diff, scan) should fire exactly once —
    // 404 must short-circuit react-query's default 3-retry policy.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('renders the submission header version, Diff tab modified file path, and Scan tab high finding message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      let body: unknown;
      if (url.endsWith('/api/v1/submissions/sub-test')) {
        body = submission;
      } else if (url.endsWith('/api/v1/submissions/sub-test/diff')) {
        body = versionDiff;
      } else if (url.endsWith('/api/v1/submissions/sub-test/scan')) {
        body = scanReport;
      } else {
        throw new Error(`unexpected fetch url ${url}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderRoute('sub-test');

    // Header: skill name and version
    expect(await screen.findByRole('heading', { name: /example-skill/i })).toBeInTheDocument();
    expect(screen.getAllByText(/2\.1\.0/).length).toBeGreaterThan(0);

    // Risk badge from VersionDiff.riskAssessment
    expect(screen.getByLabelText(/medium risk/i)).toBeInTheDocument();

    // Diff tab is default and shows the modified file path + permissions-expanded warning
    const diffPanel = screen.getByRole('tabpanel', { name: /diff/i });
    expect(diffPanel).toHaveTextContent('SKILL.md');
    expect(diffPanel).toHaveTextContent(/permissions expanded/i);

    // Switch to Scan tab — finding message at severity high
    fireEvent.click(screen.getByRole('tab', { name: /^scan$/i }));
    const scanPanel = screen.getByRole('tabpanel', { name: /scan/i });
    expect(scanPanel).toHaveTextContent(/high-severity issue found/i);
    expect(scanPanel).toHaveTextContent(/high/i);

    // Sticky decision panel is mounted with Approve + Reject controls
    const decisionSlot = screen.getByRole('complementary', { name: /decision panel/i });
    expect(decisionSlot).toContainElement(screen.getByRole('button', { name: /^approve$/i }));
    expect(decisionSlot).toContainElement(screen.getByRole('button', { name: /^reject$/i }));
  });

  it('wires evidence tabs to their panels and supports arrow-key activation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      let body: unknown;
      if (url.endsWith('/api/v1/submissions/sub-test')) {
        body = submission;
      } else if (url.endsWith('/api/v1/submissions/sub-test/diff')) {
        body = versionDiff;
      } else if (url.endsWith('/api/v1/submissions/sub-test/scan')) {
        body = scanReport;
      } else {
        throw new Error(`unexpected fetch url ${url}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    renderRoute('sub-test');

    expect(await screen.findByRole('heading', { name: /example-skill/i })).toBeInTheDocument();

    const diffTab = screen.getByRole('tab', { name: /^diff$/i });
    const scanTab = screen.getByRole('tab', { name: /^scan$/i });
    let panel = screen.getByRole('tabpanel', { name: /^diff$/i });

    expect(diffTab).toHaveAttribute('id', 'review-detail-tab-diff');
    expect(diffTab).toHaveAttribute('aria-controls', 'review-detail-panel-diff');
    expect(panel).toHaveAttribute('id', 'review-detail-panel-diff');
    expect(panel).toHaveAttribute('aria-labelledby', 'review-detail-tab-diff');
    expect(diffTab).toHaveAttribute('tabindex', '0');
    expect(scanTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(diffTab, { key: 'ArrowRight' });

    expect(scanTab).toHaveAttribute('aria-selected', 'true');
    expect(scanTab).toHaveFocus();
    panel = screen.getByRole('tabpanel', { name: /^scan$/i });
    expect(panel).toHaveAttribute('id', 'review-detail-panel-scan');
    expect(panel).toHaveAttribute('aria-labelledby', 'review-detail-tab-scan');
    expect(scanTab).toHaveAttribute('tabindex', '0');
    expect(diffTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(scanTab, { key: 'ArrowRight' });

    expect(diffTab).toHaveAttribute('aria-selected', 'true');
    expect(diffTab).toHaveFocus();
  });

  it('keeps the review page usable when diff evidence is not available yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/submissions/sub-test')) {
        return new Response(JSON.stringify(submission), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/submissions/sub-test/diff')) {
        return new Response(JSON.stringify({ error: 'diff not ready' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/submissions/sub-test/scan')) {
        return new Response(JSON.stringify(scanReport), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    }));

    renderRoute('sub-test');

    expect(await screen.findByRole('heading', { name: /example-skill/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /unable to load this submission/i })).not.toBeInTheDocument();

    const diffPanel = screen.getByRole('tabpanel', { name: /diff/i });
    expect(diffPanel).toHaveTextContent(/diff not available yet/i);

    fireEvent.click(screen.getByRole('tab', { name: /^scan$/i }));
    expect(screen.getByRole('tabpanel', { name: /scan/i })).toHaveTextContent(/high-severity issue found/i);

    const decisionSlot = screen.getByRole('complementary', { name: /decision panel/i });
    expect(decisionSlot).toContainElement(screen.getByRole('button', { name: /^approve$/i }));
    expect(decisionSlot).toContainElement(screen.getByRole('button', { name: /^reject$/i }));
  });
});
