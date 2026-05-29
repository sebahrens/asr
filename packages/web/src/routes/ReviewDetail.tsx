import type { ScanReport, Submission, VersionDiff } from '@asr/core';
import { useQuery } from '@tanstack/react-query';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DecisionPanel } from './DecisionPanel';

type TabId = 'diff' | 'scan';

const evidenceTabs: { id: TabId; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'scan', label: 'Scan' },
];

function getEvidenceTabId(tab: TabId): string {
  return `review-detail-tab-${tab}`;
}

function getEvidencePanelId(tab: TabId): string {
  return `review-detail-panel-${tab}`;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new HttpError(res.status, `Request to ${url} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

type SubmissionEvidenceKey = 'submission' | 'diff' | 'scan';

function isDevMockMode(): boolean {
  return (
    import.meta.env.MODE === 'development' &&
    !import.meta.env.VITE_API_URL
  );
}

// In `vite dev` with no API URL configured, the dev server has no backend that
// serves /api/v1/submissions/:id, so route requests through canonical mock
// evidence instead. Tests run in MODE='test' and stub fetch directly, so this
// branch is inert there.
async function fetchSubmissionEvidence<T>(
  id: string,
  kind: SubmissionEvidenceKey,
  url: string,
): Promise<T> {
  if (import.meta.env.DEV && isDevMockMode()) {
    const { getReviewSubmissionMock } = await import('../dev-mocks/reviewSubmissionMocks');
    const mock = getReviewSubmissionMock(id);
    if (mock) {
      return mock[kind] as unknown as T;
    }
  }
  return fetchJson<T>(url);
}

// react-query retries failed queries 3 times by default. For client errors
// (4xx) the response will not change on retry, so the user would otherwise
// see ~7s of "Loading…" before the error state appears on an invalid id.
function retryUnless4xx(failureCount: number, error: unknown): boolean {
  if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 3;
}

export function ReviewDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';

  const submissionQuery = useQuery({
    queryKey: ['submission', id],
    queryFn: () => fetchSubmissionEvidence<Submission>(
      id,
      'submission',
      `/api/v1/submissions/${encodeURIComponent(id)}`,
    ),
    enabled: id !== '',
    retry: retryUnless4xx,
  });
  const diffQuery = useQuery({
    queryKey: ['submission', id, 'diff'],
    queryFn: () => fetchSubmissionEvidence<VersionDiff>(
      id,
      'diff',
      `/api/v1/submissions/${encodeURIComponent(id)}/diff`,
    ),
    enabled: id !== '',
    retry: retryUnless4xx,
  });
  const scanQuery = useQuery({
    queryKey: ['submission', id, 'scan'],
    queryFn: () => fetchSubmissionEvidence<ScanReport>(
      id,
      'scan',
      `/api/v1/submissions/${encodeURIComponent(id)}/scan`,
    ),
    enabled: id !== '',
    retry: retryUnless4xx,
  });

  const [activeTab, setActiveTab] = useState<TabId>('diff');

  function focusEvidenceTab(tab: TabId) {
    document.getElementById(getEvidenceTabId(tab))?.focus();
  }

  function handleEvidenceTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();

    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + direction + evidenceTabs.length) % evidenceTabs.length;
    const nextTab = evidenceTabs[nextIndex].id;
    setActiveTab(nextTab);
    focusEvidenceTab(nextTab);
  }

  if (submissionQuery.isLoading) {
    return (
      <main className="review-detail review-detail-loading" aria-busy="true">
        <p role="status" aria-label="Loading submission detail">Loading submission…</p>
      </main>
    );
  }

  if (submissionQuery.isError) {
    return (
      <ReviewLookupState
        title="Unable to load this submission"
        message={`We could not load ${id || 'this submission'}. Return to the approval queue and choose another item, or retry.`}
      />
    );
  }

  const submission = submissionQuery.data;
  const diff = diffQuery.data;
  const scan = scanQuery.data;
  const activeTabConfig = evidenceTabs.find((tab) => tab.id === activeTab);
  const activeTabId = getEvidenceTabId(activeTab);
  const activePanelId = getEvidencePanelId(activeTab);

  if (!submission) {
    return (
      <ReviewLookupState
        title="Submission not found"
        message={`No review submission exists for ${id || 'this id'}. Return to the approval queue and choose another item.`}
      />
    );
  }

  return (
    <main className="review-detail">
      <header className="review-detail-header">
        <h1>{submission.manifest.name}</h1>
        <p className="review-detail-version">v{submission.manifest.version}</p>
        {diff ? (
          <span
            className={`risk-badge risk-${diff.riskAssessment}`}
            aria-label={`${diff.riskAssessment} risk`}
          >
            {diff.riskAssessment} risk
          </span>
        ) : null}
      </header>

      <nav role="tablist" aria-label="Submission evidence" className="review-detail-tabs">
        {evidenceTabs.map((tab, index) => (
          <button
            key={tab.id}
            id={getEvidenceTabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={getEvidencePanelId(tab.id)}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleEvidenceTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'diff' ? (
        <section
          id={activePanelId}
          role="tabpanel"
          aria-label={activeTabConfig?.label}
          aria-labelledby={activeTabId}
          className="review-detail-panel review-detail-panel-diff"
        >
          <EvidencePanelContent
            isLoading={diffQuery.isLoading}
            isError={diffQuery.isError}
            unavailableTitle="Diff not available yet"
            unavailableMessage="The submission record loaded, but the version diff is still being prepared or could not be fetched. You can review the other evidence and retry."
          >
            {diff ? <DiffPanelContent diff={diff} /> : null}
          </EvidencePanelContent>
        </section>
      ) : (
        <section
          id={activePanelId}
          role="tabpanel"
          aria-label={activeTabConfig?.label}
          aria-labelledby={activeTabId}
          className="review-detail-panel review-detail-panel-scan"
        >
          <EvidencePanelContent
            isLoading={scanQuery.isLoading}
            isError={scanQuery.isError}
            unavailableTitle="Scan still running"
            unavailableMessage="The submission record loaded, but security scan results are not ready yet or could not be fetched. You can review the other evidence and retry."
          >
            {scan ? <ScanPanelContent scan={scan} /> : null}
          </EvidencePanelContent>
        </section>
      )}

      <aside className="review-detail-decision-slot" aria-label="Decision panel">
        <DecisionPanel submission={submission} risk={diff?.riskAssessment} />
      </aside>
    </main>
  );
}

function ReviewLookupState({ title, message }: { title: string; message: string }) {
  return (
    <main className="not-found-main">
      <section
        className="not-found-state"
        role="alert"
        aria-live="assertive"
        aria-labelledby="review-lookup-title"
      >
        <p className="eyebrow">Submission lookup</p>
        <h1 id="review-lookup-title">{title}</h1>
        <p>{message}</p>
        <div className="not-found-actions">
          <Link className="primary-link" to="/review">Back to review queue</Link>
          <button
            className="secondary-btn"
            type="button"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </section>
    </main>
  );
}

function EvidencePanelContent({
  isLoading,
  isError,
  unavailableTitle,
  unavailableMessage,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  unavailableTitle: string;
  unavailableMessage: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <p className="review-detail-empty" role="status" aria-live="polite">
        {unavailableTitle}
      </p>
    );
  }

  if (isError || children === null) {
    return (
      <div className="review-detail-empty" role="status" aria-live="polite">
        <strong>{unavailableTitle}</strong>
        <span>{unavailableMessage}</span>
      </div>
    );
  }

  return children;
}

function DiffPanelContent({ diff }: { diff: VersionDiff }) {
  const { filesAdded, filesRemoved, filesModified, permissionsExpanded } = diff;
  const hasFiles = filesAdded.length + filesRemoved.length + filesModified.length > 0;

  return (
    <>
      {permissionsExpanded ? (
        <p className="review-detail-permissions-warning">Permissions expanded since previous version.</p>
      ) : null}
      {hasFiles ? (
        <ul className="review-detail-file-list">
          {filesAdded.map((file) => (
            <li key={`added-${file}`}>
              <span className="file-status file-status-added">added</span> {file}
            </li>
          ))}
          {filesRemoved.map((file) => (
            <li key={`removed-${file}`}>
              <span className="file-status file-status-removed">removed</span> {file}
            </li>
          ))}
          {filesModified.map((file) => (
            <li key={`modified-${file}`}>
              <span className="file-status file-status-modified">modified</span> {file}
            </li>
          ))}
        </ul>
      ) : (
        <p className="review-detail-empty">No file changes in this submission.</p>
      )}
    </>
  );
}

function ScanPanelContent({ scan }: { scan: ScanReport }) {
  if (scan.findings.length === 0) {
    return <p className="review-detail-empty">No findings reported.</p>;
  }
  return (
    <ul className="review-detail-scan-findings">
      {scan.findings.map((finding, idx) => (
        <li key={`${finding.tool}-${finding.ruleId}-${idx}`}>
          <span className={`severity-tag severity-${finding.severity}`}>{finding.severity}</span>
          <span className="finding-message">{finding.message}</span>
          <span className="finding-location">{finding.file}:{finding.line}</span>
        </li>
      ))}
    </ul>
  );
}
