import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiError =
  | 'authentication_required'
  | 'insufficient_permissions'
  | 'separation_of_duties_violation'
  | 'skill_not_found'
  | 'submission_not_found'
  | 'submission_not_in_expected_state'
  | 'submission_not_ready'
  | 'version_diff_not_found'
  | 'submission_in_progress'
  | 'version_already_exists'
  | 'version_in_progress'
  | 'version_yanked'
  | 'version_downgrade'
  | 'version_not_greater'
  | 'invalid_version'
  | 'invalid_zip'
  | 'invalid_manifest'
  | 'content_blocked'
  | 'too_many_requests'
  | 'audit_scope_unavailable'
  | 'audit_chain_broken'
  | 'internal_error';

export interface ApiErrorExtra {
  message?: string;
  details?: Record<string, string>;
  required?: string;
  retryAfterSeconds?: number;
  brokenAt?: string;
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: ApiError,
  extra: ApiErrorExtra = {},
): Response {
  return c.json({ error, ...extra }, status);
}
