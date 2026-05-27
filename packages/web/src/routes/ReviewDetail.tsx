import type { ScanReport, Submission, VersionDiff } from '@asr/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DecisionPanel } from './DecisionPanel';

type TabId = 'diff' | 'scan';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request to ${url} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export function ReviewDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';

  const submissionQuery = useQuery({
    queryKey: ['submission', id],
    queryFn: () => fetchJson<Submission>(`/api/v1/submissions/${encodeURIComponent(id)}`),
    enabled: id !== '',
  });
  const diffQuery = useQuery({
    queryKey: ['submission', id, 'diff'],
    queryFn: () => fetchJson<VersionDiff>(`/api/v1/submissions/${encodeURIComponent(id)}/diff`),
    enabled: id !== '',
  });
  const scanQuery = useQuery({
    queryKey: ['submission', id, 'scan'],
    queryFn: () => fetchJson<ScanReport>(`/api/v1/submissions/${encodeURIComponent(id)}/scan`),
    enabled: id !== '',
  });

  const [activeTab, setActiveTab] = useState<TabId>('diff');

  if (submissionQuery.isLoading || diffQuery.isLoading || scanQuery.isLoading) {
    return (
      <main className="review-detail review-detail-loading" aria-busy="true">
        <p role="status" aria-label="Loading submission detail">Loading submission…</p>
      </main>
    );
  }

  if (submissionQuery.isError || diffQuery.isError || scanQuery.isError) {
    return (
      <ReviewLookupState
        title="Unable to load this submission"
        message={`We could not load review evidence for ${id || 'this submission'}. Return to the approval queue and choose another item, or retry.`}
      />
    );
  }

  const submission = submissionQuery.data;
  const diff = diffQuery.data;
  const scan = scanQuery.data;

  if (!submission || !diff || !scan) {
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
        <span
          className={`risk-badge risk-${diff.riskAssessment}`}
          aria-label={`${diff.riskAssessment} risk`}
        >
          {diff.riskAssessment} risk
        </span>
      </header>

      <nav role="tablist" aria-label="Submission evidence" className="review-detail-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'diff'}
          aria-controls="review-detail-panel-diff"
          onClick={() => setActiveTab('diff')}
        >
          Diff
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'scan'}
          aria-controls="review-detail-panel-scan"
          onClick={() => setActiveTab('scan')}
        >
          Scan
        </button>
      </nav>

      {activeTab === 'diff' ? (
        <section
          id="review-detail-panel-diff"
          role="tabpanel"
          aria-label="Diff"
          className="review-detail-panel review-detail-panel-diff"
        >
          <DiffPanelContent diff={diff} />
        </section>
      ) : (
        <section
          id="review-detail-panel-scan"
          role="tabpanel"
          aria-label="Scan"
          className="review-detail-panel review-detail-panel-scan"
        >
          <ScanPanelContent scan={scan} />
        </section>
      )}

      <aside className="review-detail-decision-slot" aria-label="Decision panel">
        <DecisionPanel submission={submission} risk={diff.riskAssessment} />
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
