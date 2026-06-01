import type { RiskAssessment, Submission } from '@asr/core';
import { isApiError, type ApiError } from '@asr/core/api-errors';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiUrl } from '../api';
import { useAuthenticatedFetch, type AuthenticatedFetch } from '../auth/authenticatedFetch';
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

class DecisionRequestError extends Error {
  readonly code?: ApiError;
  readonly status: number;

  constructor(status: number, code?: ApiError, message?: string) {
    super(message ?? `Decision request failed with ${status}`);
    this.name = 'DecisionRequestError';
    this.code = code;
    this.status = status;
  }
}

async function postDecision(
  authenticatedFetch: AuthenticatedFetch,
  url: string,
  payload: ApprovePayload | RejectPayload | undefined,
): Promise<void> {
  const init: RequestInit = { method: 'POST' };
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const res = await authenticatedFetch(url, init);
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new DecisionRequestError(res.status, body.error, body.message);
  }
}

async function parseErrorBody(res: Response): Promise<{ error?: ApiError; message?: string }> {
  const text = await res.text().catch(() => '');
  if (text.length === 0) {
    return {};
  }

  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== 'object' || body === null) {
      return {};
    }

    const error = 'error' in body && isApiError(body.error) ? body.error : undefined;
    const message = 'message' in body && typeof body.message === 'string' ? body.message : undefined;
    return { error, message };
  } catch {
    return {};
  }
}

function formatDecisionError(error: unknown): string {
  if (error instanceof DecisionRequestError) {
    if (error.code === 'separation_of_duties_violation') {
      return 'Separation of duties: submitters cannot approve or reject their own submissions.';
    }

    if (error.message.length > 0 && !error.message.startsWith('Decision request failed')) {
      return error.message;
    }

    return `Unable to record the decision. The server responded with ${error.status}.`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return 'Unable to record the decision. Check your connection and try again.';
}

function invalidateDecisionQueries(queryClient: ReturnType<typeof useQueryClient>, submissionId: string) {
  void queryClient.invalidateQueries({ queryKey: ['submissions', 'pending'] });
  void queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
  void queryClient.invalidateQueries({ queryKey: ['submission', submissionId, 'diff'] });
  void queryClient.invalidateQueries({ queryKey: ['submission', submissionId, 'scan'] });
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const focusableSelector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function DecisionPanel({ submission, risk }: DecisionPanelProps) {
  const session = useSession();
  const authenticatedFetch = useAuthenticatedFetch();
  const queryClient = useQueryClient();
  const isSelf = submission.submittedBy === session.sub;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isSubmittingRef = useRef(false);

  const [reason, setReason] = useState('');
  const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<string | null>(null);

  const approveMutation = useMutation({
    mutationFn: () =>
      postDecision(
        authenticatedFetch,
        apiUrl(`/api/v1/submissions/${encodeURIComponent(submission.id)}/approve`),
        undefined,
      ),
    onSuccess: () => {
      invalidateDecisionQueries(queryClient, submission.id);
    },
    onError: () => {
      setDecisionStatus(null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (rejectReason: string) =>
      postDecision(
        authenticatedFetch,
        apiUrl(`/api/v1/submissions/${encodeURIComponent(submission.id)}/reject`),
        { reason: rejectReason },
      ),
    onSuccess: () => {
      invalidateDecisionQueries(queryClient, submission.id);
    },
    onError: () => {
      setDecisionStatus(null);
    },
  });

  const reasonTrimmed = reason.trim();
  const rejectDisabled = isSelf || reasonTrimmed.length === 0;
  const isSubmitting = approveMutation.isPending || rejectMutation.isPending;
  const activeError =
    pendingAction === 'approve'
      ? approveMutation.error
      : pendingAction === 'reject'
        ? rejectMutation.error
        : null;

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  useEffect(() => {
    if (pendingAction === null) {
      return;
    }

    confirmButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isSubmittingRef.current) {
        event.preventDefault();
        resetMutationErrors();
        setPendingAction(null);
        return;
      }

      if (event.key !== 'Tab' || dialogRef.current === null) {
        return;
      }

      const focusableElements = getFocusableElements(dialogRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const currentElement = document.activeElement;
      const currentIndex = focusableElements.findIndex((element) => element === currentElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusableElements.length - 1
          : currentIndex - 1
        : currentIndex === -1 || currentIndex === focusableElements.length - 1
          ? 0
          : currentIndex + 1;

      event.preventDefault();
      focusableElements[nextIndex]?.focus();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [pendingAction]);

  function resetMutationErrors() {
    approveMutation.reset();
    rejectMutation.reset();
  }

  function openModal(action: DecisionAction, event: ReactMouseEvent<HTMLButtonElement>) {
    resetMutationErrors();
    setDecisionStatus(null);
    triggerRef.current = event.currentTarget;
    setPendingAction(action);
  }

  function closeModal() {
    if (isSubmitting) return;
    resetMutationErrors();
    setPendingAction(null);
  }

  function confirmDecision() {
    if (pendingAction === 'approve') {
      approveMutation.mutate(undefined, {
        onSuccess: () => {
          setDecisionStatus('Submission approved.');
          setPendingAction(null);
          setReason('');
        },
      });
    } else if (pendingAction === 'reject') {
      rejectMutation.mutate(reasonTrimmed, {
        onSuccess: () => {
          setDecisionStatus('Submission rejected.');
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

      {decisionStatus ? (
        <p className="decision-panel-status" role="status">
          {decisionStatus}
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
          onClick={(event) => openModal('approve', event)}
        >
          Approve
        </button>
        <button
          type="button"
          className="decision-panel-reject"
          disabled={rejectDisabled}
          onClick={(event) => openModal('reject', event)}
        >
          Reject
        </button>
      </div>

      {pendingAction !== null && typeof document !== 'undefined'
        ? createPortal(
            <div className="decision-panel-modal-backdrop">
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={pendingAction === 'approve' ? 'Confirm approve' : 'Confirm reject'}
                className="decision-panel-modal"
                tabIndex={-1}
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
                {activeError ? (
                  <p className="decision-panel-error" role="alert">
                    {formatDecisionError(activeError)}
                  </p>
                ) : null}
                <div className="decision-panel-modal-actions">
                  <button type="button" onClick={closeModal} disabled={isSubmitting}>
                    Cancel
                  </button>
                  <button
                    ref={confirmButtonRef}
                    type="button"
                    onClick={confirmDecision}
                    disabled={isSubmitting}
                  >
                    {pendingAction === 'approve' ? 'Confirm approve' : 'Confirm reject'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
