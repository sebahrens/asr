export type NotifyEvent =
  | 'questionnaire_ready'
  | 'scan_review_required'
  | 'approved'
  | 'rejected'
  | 'sla_extended'
  | 'sla_escalated';

export interface TemplateContext {
  submissionId: string;
  baseUrl: string;
}

interface RenderedTemplate {
  subject: string;
  body: string;
}

function buildLink(baseUrl: string, submissionId: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/submissions/${submissionId}`;
}

const SUBJECTS: Record<NotifyEvent, string> = {
  questionnaire_ready: 'ASR submission: questionnaire ready',
  scan_review_required: 'ASR submission: scan review required',
  approved: 'ASR submission: approved',
  rejected: 'ASR submission: rejected',
  sla_extended: 'ASR submission: review window extended',
  sla_escalated: 'ASR submission: review escalated',
};

function bodyFor(event: NotifyEvent, link: string): string {
  switch (event) {
    case 'questionnaire_ready':
      return [
        'Your submission has reached the questionnaire stage.',
        'Open the submission to provide the required answers:',
        link,
      ].join('\n\n');
    case 'scan_review_required':
      return [
        'A submission requires manual scan review.',
        'Open the submission to inspect findings and record a decision:',
        link,
      ].join('\n\n');
    case 'approved':
      return [
        'Your submission has been approved and will be published.',
        'View the submission record:',
        link,
      ].join('\n\n');
    case 'rejected':
      return [
        'Your submission has been rejected.',
        'View the submission for rejection details:',
        link,
      ].join('\n\n');
    case 'sla_extended':
      return [
        'The review window for this submission has been extended.',
        'Open the submission to take action before the new deadline:',
        link,
      ].join('\n\n');
    case 'sla_escalated':
      return [
        'This submission has been escalated due to an unmet review SLA.',
        'Open the submission to take action:',
        link,
      ].join('\n\n');
  }
}

export function render(event: NotifyEvent, ctx: TemplateContext): RenderedTemplate {
  const link = buildLink(ctx.baseUrl, ctx.submissionId);
  return {
    subject: SUBJECTS[event],
    body: bodyFor(event, link),
  };
}
