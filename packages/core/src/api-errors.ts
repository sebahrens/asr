export const API_ERRORS = [
  'authentication_required',
  'insufficient_permissions',
  'separation_of_duties_violation',
  'skill_not_found',
  'submission_not_found',
  'submission_not_in_expected_state',
  'submission_not_ready',
  'version_diff_not_found',
  'submission_in_progress',
  'version_already_exists',
  'version_in_progress',
  'version_yanked',
  'version_downgrade',
  'version_not_greater',
  'invalid_version',
  'invalid_zip',
  'invalid_manifest',
  'content_blocked',
  'too_many_requests',
  'audit_scope_unavailable',
  'audit_chain_broken',
  'internal_error',
] as const;

export type ApiError = (typeof API_ERRORS)[number];

export interface ApiErrorBody {
  error?: ApiError;
  message?: string;
  details?: Record<string, string>;
  required?: string;
  retryAfterSeconds?: number;
  brokenAt?: string;
}

export function isApiError(value: unknown): value is ApiError {
  return typeof value === 'string' && API_ERRORS.includes(value as ApiError);
}
