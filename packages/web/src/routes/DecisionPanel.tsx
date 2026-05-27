import type { RiskAssessment, Submission } from '@asr/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../auth/useSession';

type DecisionAction = 'approve' | 'reject';

interface DecisionPanelProps {
  submission: Submission;
  risk?: RiskAssessment;
}

interface ApprovePayload {
  comment?: string;
}

interface RejectPayload {
  reason: string;
}

async function postDecision(
  url: string,
  payload: ApprovePayload | RejectPayload | undefined,
): Promise<void> {
  const init: RequestInit = { method: 'POST' };
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`POST ${url} failed with ${res.status}`);
  }
}

export function DecisionPanel({ submission, risk }: DecisionPanelProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const isSelf = submission.submittedBy === session.sub;

  const [reason, setReason] = useState('');
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);

  const approveMutation = useMutation({
    mutationFn: () =>
      postDecision(
        `/api/v1/submissions/${encodeURIComponent(submission.id)}/approve`,
        undefined,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['submissions', 'pending'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (rejectReason: string) =>
      postDecision(
        `/api/v1/submissions/${encodeURIComponent(submission.id)}/reject`,
        { reason: rejectReason },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['submissions', 'pending'] });
    },
  });

  const reasonTrimmed = reason.trim();
  const rejectDisabled = isSelf || reasonTrimmed.length === 0;
  const isSubmitting = approveMutation.isPending || rejectMutation.isPending;

  function closeModal() {
    if (isSubmitting) return;
    setPendingAction(null);
  }

  function confirmDecision() {
    if (pendingAction === 'approve') {
      approveMutation.mutate(undefined, {
        onSuccess: () => {
          setPendingAction(null);
          setReason('');
        },
      });
    } else if (pendingAction === 'reject') {
      rejectMutation.mutate(reasonTrimmed, {
        onSuccess: () => {
          setPendingAction(null);
          setReason('');
        },
      });
    }
  }

  return (
    <div className="decision-panel">
      {isSelf ? (
        <p className="decision-panel-sod-notice" role="note">
          You submitted this version, so you cannot approve or reject it (separation of duties).
        </p>
      ) : null}

      <label className="decision-panel-reason-label" htmlFor="decision-panel-reason">
        Reason (required to reject)
      </label>
      <textarea
        id="decision-panel-reason"
        className="decision-panel-reason"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={isSelf}
        rows={3}
      />

      <div className="decision-panel-actions">
        <button
          type="button"
          className="decision-panel-approve"
          disabled={isSelf}
          onClick={() => setPendingAction('approve')}
        >
          Approve
        </button>
        <button
          type="button"
          className="decision-panel-reject"
          disabled={rejectDisabled}
          onClick={() => setPendingAction('reject')}
        >
          Reject
        </button>
      </div>

      {pendingAction !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={pendingAction === 'approve' ? 'Confirm approve' : 'Confirm reject'}
          className="decision-panel-modal"
        >
          <h2 className="decision-panel-modal-title">
            {pendingAction === 'approve' ? 'Approve submission' : 'Reject submission'}
          </h2>
          <p className="decision-panel-modal-version">
            Version <strong>{submission.manifest.version}</strong>
            {risk ? (
              <>
                {' '}— risk <strong className={`risk-${risk}`}>{risk}</strong>
              </>
            ) : null}
          </p>
          {pendingAction === 'reject' ? (
            <p className="decision-panel-modal-reason">Reason: {reasonTrimmed}</p>
          ) : null}
          <div className="decision-panel-modal-actions">
            <button type="button" onClick={closeModal} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDecision}
              disabled={isSubmitting}
            >
              {pendingAction === 'approve' ? 'Confirm approve' : 'Confirm reject'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
