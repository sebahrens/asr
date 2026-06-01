import { useMemo, useState, type UIEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiUrl } from '../api';
import { useAuthenticatedFetch, type AuthenticatedFetch } from '../auth/authenticatedFetch';

const REVIEW_QUEUE_PAGE_SIZE = 50;
const REVIEW_QUEUE_ROW_HEIGHT = 82;
const REVIEW_QUEUE_VIEWPORT_HEIGHT = 560;
const REVIEW_QUEUE_OVERSCAN = 6;

export interface PendingSubmissionRow {
  id: string;
  skillName: string;
  version: string;
  status?: string | { phase: string };
  risk?: string;
  riskAssessment?: string;
  findings?: number;
}

interface PendingSubmissionsResponse {
  submissions?: PendingSubmissionRow[];
  nextCursor?: string | null;
  nextOffset?: number | null;
}

interface PendingSubmissionsPage {
  submissions: PendingSubmissionRow[];
  nextCursor: string | null;
}

async function fetchPendingSubmissionsPage({
  authenticatedFetch,
  pageParam,
}: {
  authenticatedFetch: AuthenticatedFetch;
  pageParam: string | null;
}): Promise<PendingSubmissionsPage> {
  const params = new URLSearchParams({
    status: 'pending',
    limit: String(REVIEW_QUEUE_PAGE_SIZE),
  });
  if (pageParam) {
    params.set('cursor', pageParam);
  }

  const res = await authenticatedFetch(apiUrl(`/api/v1/submissions?${params.toString()}`));
  if (!res.ok) {
    throw new Error(`Pending submissions request failed with ${res.status}`);
  }

  const body = (await res.json()) as PendingSubmissionsResponse;
  const submissions = Array.isArray(body.submissions) ? body.submissions : [];
  const nextCursor = body.nextCursor ?? (
    typeof body.nextOffset === 'number' ? String(body.nextOffset) : null
  );

  return { submissions, nextCursor };
}

export function ReviewQueue() {
  const authenticatedFetch = useAuthenticatedFetch();
  const [scrollTop, setScrollTop] = useState(0);
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['submissions', 'pending'],
    queryFn: ({ pageParam }) => fetchPendingSubmissionsPage({ authenticatedFetch, pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const submissions = useMemo(
    () => data?.pages.flatMap((page) => page.submissions) ?? [],
    [data],
  );
  const virtualRows = useMemo(
    () => getVirtualReviewRows(submissions, scrollTop),
    [scrollTop, submissions],
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  return (
    <main className="review-queue">
      <header className="review-queue-header">
        <h1>Review queue</h1>
        <p>Pending compliance review for new and updated skill submissions.</p>
      </header>

      {isLoading ? (
        <ul
          className="review-queue-skeleton"
          role="status"
          aria-label="Loading pending submissions"
        >
          <li className="review-queue-skeleton-row" />
          <li className="review-queue-skeleton-row" />
          <li className="review-queue-skeleton-row" />
        </ul>
      ) : isError ? (
        <p className="review-queue-error" role="alert">
          Unable to load pending submissions.
        </p>
      ) : submissions.length === 0 ? (
        <p className="empty-review-queue" role="status">
          No submissions awaiting review
        </p>
      ) : (
        <section className="review-queue-results" aria-label="Pending submissions">
          <div
            className="review-queue-viewport"
            onScroll={handleScroll}
          >
            <table className="review-queue-table">
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {virtualRows.topPadding > 0 ? (
                  <tr aria-hidden="true" className="review-queue-spacer-row">
                    <td colSpan={4} style={{ height: virtualRows.topPadding }} />
                  </tr>
                ) : null}
                {virtualRows.rows.map((submission) => (
                  <ReviewQueueRow key={submission.id} submission={submission} />
                ))}
                {virtualRows.bottomPadding > 0 ? (
                  <tr aria-hidden="true" className="review-queue-spacer-row">
                    <td colSpan={4} style={{ height: virtualRows.bottomPadding }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {hasNextPage ? (
            <button
              className="review-queue-load-more"
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading...' : 'Load more'}
            </button>
          ) : null}
        </section>
      )}
    </main>
  );
}

function ReviewQueueRow({ submission }: { submission: PendingSubmissionRow }) {
  const status = formatSubmissionStatus(submission.status);
  const risk = submission.riskAssessment ?? submission.risk;

  return (
    <tr>
      <th scope="row">
        <div className="review-queue-skill-cell">
          <Link to={`/review/${submission.id}`}>
            {submission.skillName}
          </Link>
          {risk ? (
            <span className={`risk-pill risk-${risk}`}>
              {risk} risk
            </span>
          ) : null}
        </div>
      </th>
      <td>{submission.version}</td>
      <td>
        <span className={`status-pill status-${status.className}`}>
          {status.label}
        </span>
        {typeof submission.findings === 'number' ? (
          <span className="review-queue-findings">
            {submission.findings} findings
          </span>
        ) : null}
      </td>
      <td>
        <div className="review-queue-actions" aria-label={`Review actions for ${submission.skillName}`}>
          <Link className="review-detail-link" to={`/review/${submission.id}`}>
            Review
          </Link>
          <Link className="approve-btn" to={`/review/${submission.id}`}>
            Approve
          </Link>
          <Link className="reject-btn" to={`/review/${submission.id}`}>
            Reject
          </Link>
        </div>
      </td>
    </tr>
  );
}

function getVirtualReviewRows(submissions: PendingSubmissionRow[], scrollTop: number) {
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / REVIEW_QUEUE_ROW_HEIGHT) - REVIEW_QUEUE_OVERSCAN,
  );
  const visibleCount =
    Math.ceil(REVIEW_QUEUE_VIEWPORT_HEIGHT / REVIEW_QUEUE_ROW_HEIGHT) +
    REVIEW_QUEUE_OVERSCAN * 2;
  const endIndex = Math.min(submissions.length, startIndex + visibleCount);

  return {
    rows: submissions.slice(startIndex, endIndex),
    topPadding: startIndex * REVIEW_QUEUE_ROW_HEIGHT,
    bottomPadding: Math.max(0, (submissions.length - endIndex) * REVIEW_QUEUE_ROW_HEIGHT),
  };
}

function formatSubmissionStatus(
  status: PendingSubmissionRow['status'],
): { label: string; className: string } {
  const raw = typeof status === 'object' && status !== null
    ? status.phase
    : status ?? 'pending review';
  const label = raw.replace(/-/g, ' ');

  return {
    label,
    className: label.toLowerCase().replace(/\s+/g, '-'),
  };
}
