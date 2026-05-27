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

function renderRoute(id: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
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
    expect(screen.getByText(/2\.1\.0/)).toBeInTheDocument();

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
});
