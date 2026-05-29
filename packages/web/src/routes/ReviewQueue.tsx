import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiUrl } from '../api';

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
}

async function fetchPendingSubmissions(): Promise<PendingSubmissionRow[]> {
  const res = await fetch(apiUrl('/api/v1/submissions?status=pending'));
  if (!res.ok) {
    throw new Error(`Pending submissions request failed with ${res.status}`);
  }

  const body = (await res.json()) as PendingSubmissionsResponse;
  return Array.isArray(body.submissions) ? body.submissions : [];
}

export function ReviewQueue() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['submissions', 'pending'],
    queryFn: fetchPendingSubmissions,
  });

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
      ) : (data ?? []).length === 0 ? (
        <p className="empty-review-queue" role="status">
          No submissions awaiting review
        </p>
      ) : (
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
            {(data ?? []).map((submission) => {
              const status = formatSubmissionStatus(submission.status);
              const risk = submission.riskAssessment ?? submission.risk;

              return (
                <tr key={submission.id}>
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
            })}
          </tbody>
        </table>
      )}
    </main>
  );
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
