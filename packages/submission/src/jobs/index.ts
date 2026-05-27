import {
  registerSlaTimeoutJob,
  type RegisterSlaTimeoutJobConfig,
  type SlaTimeoutJobHandle,
} from './slaTimeout.js';

export interface StartJobsOptions {
  slaTimeout?: RegisterSlaTimeoutJobConfig;
}

export interface JobsHandle {
  stop(): void;
}

export function startJobs(options: StartJobsOptions = {}): JobsHandle {
  const handles: SlaTimeoutJobHandle[] = [];
  if (options.slaTimeout) {
    handles.push(registerSlaTimeoutJob(options.slaTimeout));
  }

  return {
    stop() {
      for (const handle of handles) {
        handle.stop();
      }
    },
  };
}

export {
  registerSlaTimeoutJob,
  runSlaSweep,
  type HitlStageRecord,
  type RegisterSlaTimeoutJobConfig,
  type SlaRejectInput,
  type SlaSweepResult,
  type SlaTimeoutDeps,
  type SlaTimeoutJobHandle,
} from './slaTimeout.js';
