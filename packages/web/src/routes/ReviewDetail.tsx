import type { ScanFinding, ScanReport, ScanSeverity, ScanTool, Submission, VersionDiff } from '@asr/core';
import { useQuery } from '@tanstack/react-query';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import {
  mobileReviewDiffViewerStyles,
  reviewDiffViewerStyles,
} from '../App';
import { apiUrl } from '../api';
import { DecisionPanel } from './DecisionPanel';

interface DiffFile {
  file: string;
  summary: string;
  additions: number;
  removals: number;
  oldValue: string;
  newValue: string;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

function renderManifestSnapshot(diff: VersionDiff, side: 'before' | 'after'): string {
  const perms = side === 'before' ? diff.permissionsBefore : diff.permissionsAfter;
  const version = side === 'before' ? diff.fromVersion : diff.toVersion;
  const lines: string[] = [
    `name: ${diff.skillName}`,
    `version: ${version || '—'}`,
    'permissions:',
  ];
  if (perms) {
    lines.push(`  network: ${perms.network}`);
    if (perms.networkHosts && perms.networkHosts.length > 0) {
      lines.push(`  networkHosts:`);
      for (const host of perms.networkHosts) lines.push(`    - ${host}`);
    }
    lines.push(`  filesystem: ${perms.filesystem}`);
    lines.push(`  subprocess: ${perms.subprocess}`);
    lines.push(`  environment: [${(perms.environment ?? []).join(', ')}]`);
  } else {
    lines.push('  (no permissions block in previous version)');
  }
  if (side === 'after' || Object.keys(diff.dependenciesAdded).length > 0 || Object.keys(diff.dependenciesChanged).length > 0) {
    lines.push('dependencies:');
    const depsForSide: Record<string, string> = {};
    for (const [k, v] of Object.entries(diff.dependenciesChanged)) {
      depsForSide[k] = side === 'before' ? v.from : v.to;
    }
    if (side === 'after') {
      for (const [k, v] of Object.entries(diff.dependenciesAdded)) depsForSide[k] = v;
    } else {
      for (const [k, v] of Object.entries(diff.dependenciesRemoved)) depsForSide[k] = v;
    }
    for (const [k, v] of Object.entries(depsForSide)) lines.push(`  ${k}: ${v}`);
  }
  return lines.join('\n') + '\n';
}

function buildDiffFiles(diff: VersionDiff): DiffFile[] {
  return [
    ...diff.filesModified.map<DiffFile>((file) => {
      if (file === 'SKILL.md' || file.endsWith('manifest.yaml') || file.endsWith('package.json')) {
        return {
          file,
          summary: 'Modified manifest — permission and dependency changes shown below.',
          additions: Object.keys(diff.dependenciesAdded).length + Object.keys(diff.dependenciesChanged).length + (diff.permissionsExpanded ? 1 : 0),
          removals: Object.keys(diff.dependenciesRemoved).length,
          oldValue: renderManifestSnapshot(diff, 'before'),
          newValue: renderManifestSnapshot(diff, 'after'),
        };
      }
      return {
        file,
        summary: `Modified between ${diff.fromVersion || 'previous'} and ${diff.toVersion}.`,
        additions: 1,
        removals: 1,
        oldValue: `// ${file}\n// Previous content from version ${diff.fromVersion || '—'}.\n// Registry stores the canonical bytes; the diff payload references them by hash.\n`,
        newValue: `// ${file}\n// Updated content for version ${diff.toVersion}.\n// Registry stores the canonical bytes; the diff payload references them by hash.\n`,
      };
    }),
    ...diff.filesAdded.map<DiffFile>((file) => ({
      file,
      summary: `Added in ${diff.toVersion}.`,
      additions: 1,
      removals: 0,
      oldValue: '',
      newValue: `// ${file}\n// New file introduced in ${diff.toVersion}.\n`,
    })),
    ...diff.filesRemoved.map<DiffFile>((file) => ({
      file,
      summary: `Removed after ${diff.fromVersion || 'initial publish'}.`,
      additions: 0,
      removals: 1,
      oldValue: `// ${file}\n// Present in ${diff.fromVersion || 'previous version'}.\n`,
      newValue: '',
    })),
  ];
}

function formatScanDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'Unknown';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatScanTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function sortFindingsBySeverity(findings: ScanFinding[]): ScanFinding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId);
  });
}

function groupFindingsByTool(findings: ScanFinding[]): Array<{ tool: ScanTool; findings: ScanFinding[] }> {
  return scanTools
    .map((tool) => ({ tool, findings: sortFindingsBySeverity(findings.filter((finding) => finding.tool === tool)) }))
    .filter((group) => group.findings.length > 0);
}

type TabId = 'diff' | 'scan';

const evidenceTabs: { id: TabId; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'scan', label: 'Scan' },
];

const scanTools: ScanTool[] = ['gitleaks', 'trivy', 'foxguard', 'opengrep', 'veracode'];

const severityRank: Record<ScanSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const verdictLabels: Record<ScanReport['verdict'], string> = {
  pass: 'Pass',
  review_required: 'Review required',
  block: 'Block',
};

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
      apiUrl(`/api/v1/submissions/${encodeURIComponent(id)}`),
    ),
    enabled: id !== '',
    retry: retryUnless4xx,
  });
  const diffQuery = useQuery({
    queryKey: ['submission', id, 'diff'],
    queryFn: () => fetchSubmissionEvidence<VersionDiff>(
      id,
      'diff',
      apiUrl(`/api/v1/submissions/${encodeURIComponent(id)}/diff`),
    ),
    enabled: id !== '',
    retry: retryUnless4xx,
  });
  const scanQuery = useQuery({
    queryKey: ['submission', id, 'scan'],
    queryFn: () => fetchSubmissionEvidence<ScanReport>(
      id,
      'scan',
      apiUrl(`/api/v1/submissions/${encodeURIComponent(id)}/scan`),
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
  const isNarrowDiff = useMediaQuery('(max-width: 640px)');
  const files = buildDiffFiles(diff);
  const hasFiles = files.length > 0;

  return (
    <>
      {diff.permissionsExpanded ? (
        <p className="review-detail-permissions-warning">Permissions expanded since previous version.</p>
      ) : null}
      {hasFiles ? (
        <div className="review-diff-list">
          {files.map((file) => {
            const kind = file.oldValue === '' ? 'added' : file.newValue === '' ? 'removed' : 'modified';
            return (
              <section className="review-diff-file" key={file.file} aria-label={`${file.file} diff`}>
                <header className="review-diff-file-header">
                  <div>
                    <h2>
                      <span className={`file-status file-status-${kind}`}>{kind}</span> {file.file}
                    </h2>
                    <p>{file.summary}</p>
                  </div>
                  <span>+{file.additions} / -{file.removals}</span>
                </header>
                <div
                  className={`review-diff-viewer${isNarrowDiff ? ' review-diff-viewer-mobile' : ''}`}
                  role="region"
                  aria-label={`${file.file} line-level diff, scrollable code region`}
                  tabIndex={0}
                >
                  <ReactDiffViewer
                    oldValue={file.oldValue}
                    newValue={file.newValue}
                    splitView={!isNarrowDiff}
                    showDiffOnly={false}
                    compareMethod={DiffMethod.WORDS}
                    hideLineNumbers={isNarrowDiff}
                    leftTitle={`Previous (${diff.fromVersion || '—'})`}
                    rightTitle={`Submitted (${diff.toVersion})`}
                    styles={isNarrowDiff ? mobileReviewDiffViewerStyles : reviewDiffViewerStyles}
                    useDarkTheme={false}
                  />
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <p className="review-detail-empty">No file changes in this submission.</p>
      )}
    </>
  );
}

function ScanPanelContent({ scan }: { scan: ScanReport }) {
  const groupedFindings = groupFindingsByTool(scan.findings);

  return (
    <div className="review-scan-report">
      <section
        className={`scan-verdict-banner scan-verdict-${scan.verdict}`}
        aria-label={`Scan verdict: ${verdictLabels[scan.verdict]}`}
      >
        <span>Verdict</span>
        <strong>{verdictLabels[scan.verdict]}</strong>
      </section>

      <dl className="scan-report-meta" aria-label="Scan report metadata">
        <div>
          <dt>Scanner image</dt>
          <dd>{scan.scannerImage}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatScanDuration(scan.durationMs)}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{formatScanTimestamp(scan.completedAt)}</dd>
        </div>
      </dl>

      <section className="scan-tool-summary" aria-labelledby="scan-tool-summary-heading">
        <h2 id="scan-tool-summary-heading">Tool results</h2>
        <div className="scan-tool-grid">
          {scanTools.map((tool) => {
            const result = scan.toolResults[tool];
            const skipped = result?.skipped === true;
            const exitCode = result?.exitCode;
            const hasNonZeroExit = typeof exitCode === 'number' && exitCode !== 0;
            return (
              <article className="scan-tool-card" key={tool} aria-label={`${tool} result`}>
                <header>
                  <strong>{tool}</strong>
                  <span className={`tool-state ${skipped ? 'tool-state-skipped' : 'tool-state-ran'}`}>
                    {skipped ? 'skipped' : 'ran'}
                  </span>
                </header>
                <p>{result?.findingCount ?? 0} findings</p>
                <span className={hasNonZeroExit ? 'tool-exit tool-exit-nonzero' : 'tool-exit'}>
                  exit {exitCode ?? 'n/a'}
                </span>
              </article>
            );
          })}
        </div>
      </section>

      {groupedFindings.length === 0 ? (
        <p className="review-detail-empty">No findings reported.</p>
      ) : (
        <div className="review-detail-scan-groups">
          {groupedFindings.map((group) => (
            <section className="review-detail-scan-group" key={group.tool} aria-labelledby={`scan-findings-${group.tool}`}>
              <h2 id={`scan-findings-${group.tool}`}>{group.tool}</h2>
              <ul className="review-detail-scan-findings">
                {group.findings.map((finding, idx) => (
                  <li key={`${finding.tool}-${finding.ruleId}-${finding.file}-${finding.line}-${idx}`}>
                    <details>
                      <summary>
                        <span className={`severity-tag severity-${finding.severity}`}>{finding.severity}</span>
                        <span className="finding-message">{finding.message}</span>
                        <span className="finding-location">{finding.file}:{finding.line}</span>
                      </summary>
                      <div className="scan-finding-detail">
                        <dl>
                          <div>
                            <dt>Rule</dt>
                            <dd>{finding.ruleId}</dd>
                          </div>
                        </dl>
                        {finding.snippet ? <pre>{finding.snippet}</pre> : null}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
