export class LockVersionMismatchError extends Error {
  constructor(
    readonly submissionId: string,
    readonly expectedLockVersion: number,
  ) {
    super(
      `submission ${submissionId} lock_version did not match expected version ${expectedLockVersion}`,
    );
    this.name = 'LockVersionMismatchError';
  }
}
