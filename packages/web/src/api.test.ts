import { describe, expect, it } from 'vitest';
import { apiUrlWithBase } from './api';

describe('apiUrlWithBase', () => {
  it('keeps API paths relative when no API base URL is configured', () => {
    expect(apiUrlWithBase('/api/v1/submissions?status=pending', '')).toBe(
      '/api/v1/submissions?status=pending',
    );
  });

  it('routes API paths to the configured API origin', () => {
    expect(apiUrlWithBase('/api/v1/submissions?status=pending', 'http://localhost:3001/')).toBe(
      'http://localhost:3001/api/v1/submissions?status=pending',
    );
  });
});
