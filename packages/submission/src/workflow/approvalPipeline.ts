import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission, type VersionDiff } from '@asr/core';
import { createFlow, FlowRuntime, type NodeContext, type WorkflowResult } from 'flowcraft';
import { runScanner, type RunScannerInput } from '../scan/runScanner.js';
import { classifySkill } from '../zip/classify.js';

const dayMs = 24 * 60 * 60 * 1000;

export interface SubmissionFile {
  path: string;
  contentBase64: string;
}

export interface ApprovalPipelineContext {
  submissionId: string;
  submission: Submission;
  manifest: SkillManifest;
  files: SubmissionFile[];
  contentHash: string;
  extractedDir: string;
  zipBufferBase64: string;
  versionDiff?: VersionDiff;

  classification?: Submission['classification'];
  branchName?: string;
  prNumber?: number;
  questionnaire?: HitlSignal;
  confirmation?: HitlSignal;
  review?: HitlSignal;
  scanReport?: ScanReport;
  mergeCommit?: string;
  status?: Submission['status']['phase'];
  _awaitingNodeIds?: string[];
}

export interface HitlSignal {
  actor: string;
  responses?: unknown;
  confirmed?: boolean;
  decision?: 'approved' | 'rejected';
  reason?: string;
}

export interface ApprovalPipelineDependencies {
  svc<T>(token: unknown): T;
  audit(action: AuditAction, detail: Record<string, unknown>): Promise<void> | void;
  runScanner?: (input: RunScannerInput) => Promise<ScanReport>;
  regenerateRegistryIndex?: () => Promise<void> | void;
  now?: () => Date;
}

type PipelineNodeContext = NodeContext<ApprovalPipelineContext, ApprovalPipelineDependencies>;

export interface HitlActorContext {
  get<T = unknown>(key: string): T;
}

const submitterActors = (ctx: HitlActorContext): string[] => [
  ctx.get<Submission>('submission').submittedBy,
];

const hitlNodeParams = {
  questionnaire: {
    type: 'questionnaire',
    timeout: '7d',
  },
  confirmation: {
    type: 'scan-results',
    timeout: '14d',
    allowedActors: 'submitter',
  },
  review: {
    type: 'compliance-approval',
    timeout: '30d',
    requiredRole: 'Compliance',
    forbiddenActors: 'submitter',
  },
} as const;

export const hitlNodes = {
  questionnaire: {
    type: 'questionnaire' as const,
    timeout: '7d' as const,
  },
  confirmation: {
    type: 'scan-results' as const,
    timeout: '14d' as const,
    allowedActors: submitterActors,
  },
  review: {
    type: 'compliance-approval' as const,
    timeout: '30d' as const,
    requiredRole: 'Compliance' as const,
    forbiddenActors: submitterActors,
  },
};

export const approvalPipeline = createFlow<ApprovalPipelineContext, ApprovalPipelineDependencies>(
  'skill-approval',
)
  .node('classify', classifyNode, {
    params: { idempotent: true },
  })
  .node('push-to-forgejo', pushToForgejoNode, {
    params: { idempotent: true },
  })
  .wait('questionnaire', {
    params: hitlNodeParams.questionnaire,
    config: { timeout: 7 * dayMs },
  })
  .node('scan', scanNode, {
    params: { idempotent: true },
  })
  .wait('confirmation', {
    params: hitlNodeParams.confirmation,
    config: { timeout: 14 * dayMs },
  })
  .wait('review', {
    params: hitlNodeParams.review,
    config: { timeout: 30 * dayMs },
  })
  .node('auto-approve', autoApproveNode, {
    params: { idempotent: true },
  })
  .node('publish', publishNode, {
    params: { idempotent: true },
    config: { joinStrategy: 'any' },
  })
  .node('rejected', rejectedNode, {
    params: { idempotent: true },
  })
  .edge('classify', 'push-to-forgejo')
  .edge('push-to-forgejo', 'questionnaire', { action: 'code-containing' })
  .edge('questionnaire', 'scan')
  .edge('scan', 'confirmation', { action: 'continue' })
  .edge('scan', 'rejected', { action: 'block' })
  .edge('confirmation', 'review')
  .edge('review', 'publish')
  .edge('push-to-forgejo', 'auto-approve', { action: 'md-only' })
  .edge('auto-approve', 'publish');

export function createApprovalPipelineRuntime(
  dependencies: ApprovalPipelineDependencies,
): FlowRuntime<ApprovalPipelineContext, ApprovalPipelineDependencies> {
  return new FlowRuntime<ApprovalPipelineContext, ApprovalPipelineDependencies>({ dependencies });
}

export async function runApprovalPipeline(
  initialState: ApprovalPipelineContext,
  dependencies: ApprovalPipelineDependencies,
): Promise<WorkflowResult<ApprovalPipelineContext>> {
  return approvalPipeline.run(createApprovalPipelineRuntime(dependencies), initialState);
}

export async function resumeApprovalPipeline(
  serializedContext: string,
  signal: HitlSignal,
  nodeId: 'questionnaire' | 'confirmation' | 'review',
  dependencies: ApprovalPipelineDependencies,
): Promise<WorkflowResult<ApprovalPipelineContext>> {
  return approvalPipeline.resume(createApprovalPipelineRuntime(dependencies), serializedContext, {
    output: signal,
    action: signal.decision ?? 'completed',
  }, nodeId);
}

async function classifyNode({ context, dependencies }: PipelineNodeContext) {
  const existing = await context.get('classification');
  if (existing) {
    return { action: existing };
  }

  const files = (await context.get('files')) ?? [];
  const classification = classifySkill(files.map((file) => file.path));
  await context.set('classification', classification);
  await dependencies.audit('workflow.classify.completed', { classification });
  return { action: classification };
}

async function pushToForgejoNode({ context, dependencies }: PipelineNodeContext) {
  const existingPrNumber = await context.get('prNumber');
  const existingBranchName = await context.get('branchName');
  const classification = required(await context.get('classification'), 'classification');
  if (existingPrNumber !== undefined && existingBranchName) {
    return { action: classification };
  }

  const forgejo = dependencies.svc<ForgejoClient>(ForgejoClient);
  const submissionId = required(await context.get('submissionId'), 'submissionId');
  const manifest = required(await context.get('manifest'), 'manifest');
  const files = required(await context.get('files'), 'files');
  const result = await forgejo.openSubmissionPR({
    submissionId,
    manifest,
    files: files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.contentBase64, 'base64'),
    })),
    autoApprove: classification === 'md-only',
  });

  await context.set('branchName', result.branch);
  await context.set('prNumber', result.prNumber);
  await dependencies.audit('workflow.pushed_to_forgejo', {
    branch: result.branch,
    prNumber: result.prNumber,
    autoApprove: classification === 'md-only',
  });

  return { action: classification };
}

async function scanNode({ context, dependencies }: PipelineNodeContext) {
  const existingReport = await context.get('scanReport');
  if (existingReport) {
    return { action: existingReport.verdict === 'block' ? 'block' : 'continue' };
  }

  await dependencies.audit('workflow.questionnaire.completed', {
    questionnaire: await context.get('questionnaire'),
  });
  await dependencies.audit('workflow.scan.started', {});

  const scanner = dependencies.runScanner ?? runScanner;
  const report = await scanner({
    submissionId: required(await context.get('submissionId'), 'submissionId'),
    contentHash: required(await context.get('contentHash'), 'contentHash'),
    extractedDir: required(await context.get('extractedDir'), 'extractedDir'),
  });

  await context.set('scanReport', report);
  await dependencies.audit('workflow.scan.completed', {
    scanId: report.scanId,
    verdict: report.verdict,
  });

  return { action: report.verdict === 'block' ? 'block' : 'continue' };
}

async function autoApproveNode({ dependencies }: PipelineNodeContext) {
  await dependencies.audit('workflow.review.approved', { actor: 'system', auto: true });
  return { action: 'approved' };
}

async function publishNode({ context, dependencies }: PipelineNodeContext) {
  const review = await context.get('review') as HitlSignal | undefined;
  if (review?.decision === 'rejected') {
    await context.set('status', 'rejected');
    await dependencies.audit('workflow.review.rejected', {
      actor: review.actor,
      reason: review.reason ?? 'rejected',
    });
    return { action: 'rejected' };
  }

  const confirmation = await context.get('confirmation') as HitlSignal | undefined;
  if (confirmation) {
    await dependencies.audit('workflow.confirmation.received', {
      actor: confirmation.actor,
      confirmed: confirmation.confirmed ?? true,
    });
  }

  if (review) {
    await dependencies.audit('workflow.review.approved', { actor: review.actor });
  }

  const forgejo = dependencies.svc<ForgejoClient>(ForgejoClient);
  const manifest = required(await context.get('manifest'), 'manifest');
  const prNumber = required(await context.get('prNumber'), 'prNumber');
  const merge = await forgejo.mergePR(prNumber);
  await forgejo.publishArtifact({
    owner: manifest.author,
    name: manifest.name,
    version: manifest.version,
    zipBuffer: Buffer.from(required(await context.get('zipBufferBase64'), 'zipBufferBase64'), 'base64'),
  });
  await dependencies.regenerateRegistryIndex?.();

  const branchName = await context.get('branchName');
  if (branchName) {
    await forgejo.deleteBranch(branchName);
  }

  await context.set('mergeCommit', merge.sha);
  await context.set('status', 'published');
  await dependencies.audit('workflow.published', { mergeCommit: merge.sha });
  return { action: 'published' };
}

async function rejectedNode({ context, dependencies }: PipelineNodeContext) {
  await context.set('status', 'rejected');
  await dependencies.audit('workflow.review.rejected', { actor: 'system', reason: 'scan_block' });
  return { action: 'rejected' };
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}
