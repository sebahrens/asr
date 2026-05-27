import type { EmitAuditInput } from '../audit/emit.js';
import { computeDeadline, nextAction, type SlaStage } from '../workflow/slaPolicy.js';

export interface HitlStageRecord {
  submissionId: string;
  stage: SlaStage;
  enteredAtIso: string;
  alreadyExtended: boolean;
}

export interface SlaRejectInput {
  submissionId: string;
  reason: string;
  stage: SlaStage;
}

export interface SlaTimeoutDeps {
  readActiveHitlStages(): Promise<HitlStageRecord[]> | HitlStageRecord[];
  markExtended(submissionId: string, stage: SlaStage): Promise<void> | void;
  deliverReject(input: SlaRejectInput): Promise<void> | void;
  notifySlaExtended(submissionId: string): Promise<void> | void;
  notifySlaEscalated(submissionId: string): Promise<void> | void;
  emitAudit(input: EmitAuditInput): Promise<void> | void;
}

export interface SlaSweepResult {
  extended: string[];
  escalated: string[];
  rejected: string[];
}

/**
 * Periodic SLA enforcement pass: extends questionnaires once, then auto-rejects;
 * auto-rejects stale confirmations immediately; escalates stale 30d compliance
 * reviews to an admin with a one-time 7d extension, then auto-rejects with a
 * `workflow.review.rejected` audit event.
 */
export async function runSlaSweep(
  now: Date,
  deps: SlaTimeoutDeps,
): Promise<SlaSweepResult> {
  const stages = await deps.readActiveHitlStages();
  const extended: string[] = [];
  const escalated: string[] = [];
  const rejected: string[] = [];

  for (const stage of stages) {
    const deadline = computeDeadline(stage.stage, stage.enteredAtIso, stage.alreadyExtended);
    if (now.getTime() <= deadline.getTime()) {
      continue;
    }

    const action = nextAction(stage.stage, stage.alreadyExtended);
    if (action === 'extend') {
      await deps.markExtended(stage.submissionId, stage.stage);
      await deps.notifySlaExtended(stage.submissionId);
      extended.push(stage.submissionId);
      continue;
    }

    if (action === 'escalate') {
      await deps.markExtended(stage.submissionId, stage.stage);
      await deps.notifySlaEscalated(stage.submissionId);
      escalated.push(stage.submissionId);
      continue;
    }

    if (action === 'auto_reject') {
      await deps.deliverReject({
        submissionId: stage.submissionId,
        reason: 'timeout',
        stage: stage.stage,
      });
      // Compliance review rejections get the dedicated review audit action;
      // questionnaire/confirmation use the generic submission.expired action.
      const auditAction =
        stage.stage === 'review' ? 'workflow.review.rejected' : 'submission.expired';
      await deps.emitAudit({
        action: auditAction,
        submissionId: stage.submissionId,
        actor: 'system',
        actorType: 'system',
        detail: { reason: 'timeout', stage: stage.stage },
      });
      rejected.push(stage.submissionId);
    }
  }

  return { extended, escalated, rejected };
}

export interface RegisterSlaTimeoutJobConfig {
  intervalMs: number;
  deps: SlaTimeoutDeps;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export interface SlaTimeoutJobHandle {
  stop(): void;
}

export function registerSlaTimeoutJob(
  config: RegisterSlaTimeoutJobConfig,
): SlaTimeoutJobHandle {
  const now = config.now ?? (() => new Date());
  const handle = setInterval(() => {
    void runSlaSweep(now(), config.deps).catch((err) => {
      config.log?.('sla sweep failed', err);
    });
  }, config.intervalMs);
  // setInterval handles in Node have unref; in vitest/jsdom they may not.
  (handle as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
