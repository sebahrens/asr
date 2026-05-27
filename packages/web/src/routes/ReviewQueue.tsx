import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

export interface PendingSubmissionRow {
  id: string;
  skillName: string;
  version: string;
}

interface PendingSubmissionsResponse {
  submissions?: PendingSubmissionRow[];
}

async function fetchPendingSubmissions(): Promise<PendingSubmissionRow[]> {
  const res = await fetch('/api/v1/submissions?status=pending');
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
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((submission) => (
              <tr key={submission.id}>
                <th scope="row">
                  <Link to={`/review/${submission.id}`}>
                    {submission.skillName}
                  </Link>
                </th>
                <td>{submission.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
