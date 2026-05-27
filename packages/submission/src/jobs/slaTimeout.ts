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
  emitAudit(input: EmitAuditInput): Promise<void> | void;
}

export interface SlaSweepResult {
  extended: string[];
  rejected: string[];
}

/**
 * Periodic SLA enforcement pass: extends questionnaires once, then auto-rejects;
 * auto-rejects stale confirmations immediately. The 30d compliance-review
 * escalate branch is owned by a separate task (asr-h4i.3) and intentionally
 * left untouched here.
 */
export async function runSlaSweep(
  now: Date,
  deps: SlaTimeoutDeps,
): Promise<SlaSweepResult> {
  const stages = await deps.readActiveHitlStages();
  const extended: string[] = [];
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

    if (action === 'auto_reject') {
      await deps.deliverReject({
        submissionId: stage.submissionId,
        reason: 'timeout',
        stage: stage.stage,
      });
      await deps.emitAudit({
        action: 'submission.expired',
        submissionId: stage.submissionId,
        actor: 'system',
        actorType: 'system',
        detail: { reason: 'timeout', stage: stage.stage },
      });
      rejected.push(stage.submissionId);
    }
    // 'escalate' is the 30d compliance-review branch — owned by asr-h4i.3.
  }

  return { extended, rejected };
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
