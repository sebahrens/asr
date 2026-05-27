export type SlaStage = 'questionnaire' | 'confirmation' | 'review';

export type SlaAction = 'extend' | 'auto_reject' | 'escalate';

export interface SlaStagePolicy {
  timeoutDays: number;
  firstExpiry: SlaAction;
  extensionDays: number;
}

export const SLA_POLICY: Record<SlaStage, SlaStagePolicy> = {
  questionnaire: { timeoutDays: 7, firstExpiry: 'extend', extensionDays: 7 },
  confirmation: { timeoutDays: 14, firstExpiry: 'auto_reject', extensionDays: 0 },
  review: { timeoutDays: 30, firstExpiry: 'escalate', extensionDays: 7 },
};

const dayMs = 24 * 60 * 60 * 1000;

export function computeDeadline(stage: SlaStage, enteredAtIso: string, extended = false): Date {
  const policy = SLA_POLICY[stage];
  const entered = Date.parse(enteredAtIso);
  if (Number.isNaN(entered)) {
    throw new TypeError(`computeDeadline: invalid ISO timestamp ${enteredAtIso}`);
  }
  const days = policy.timeoutDays + (extended ? policy.extensionDays : 0);
  return new Date(entered + days * dayMs);
}

export function nextAction(stage: SlaStage, alreadyExtended: boolean): SlaAction {
  if (stage === 'confirmation') return 'auto_reject';
  return alreadyExtended ? 'auto_reject' : SLA_POLICY[stage].firstExpiry;
}
