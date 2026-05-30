import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError, ApiErrorBody } from '@asr/core/api-errors';

export type { ApiError, ApiErrorBody } from '@asr/core/api-errors';

export type ApiErrorExtra = Omit<ApiErrorBody, 'error'>;

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: ApiError,
  extra: ApiErrorExtra = {},
): Response {
  return c.json({ error, ...extra }, status);
}
