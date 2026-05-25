import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ApiError =
  | 'authentication_required'
  | 'insufficient_permissions'
  | 'separation_of_duties_violation'
  | 'skill_not_found'
  | 'submission_not_found'
  | 'version_diff_not_found'
  | 'submission_in_progress'
  | 'version_already_exists'
  | 'version_in_progress'
  | 'version_yanked'
  | 'version_downgrade'
  | 'invalid_zip'
  | 'invalid_manifest'
  | 'content_blocked'
  | 'too_many_requests'
  | 'audit_chain_broken'
  | 'internal_error';

export interface ApiErrorExtra {
  message?: string;
  details?: Record<string, string>;
  required?: string;
  retryAfterSeconds?: number;
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: ApiError,
  extra: ApiErrorExtra = {},
): Response {
  return c.json({ error, ...extra }, status);
}
