import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

function ThrowingChild(): never {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders ErrorPage and logs the component stack when a child render throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'Top-level React render error',
      expect.objectContaining({
        error: expect.objectContaining({ message: 'render failed' }),
        componentStack: expect.stringContaining('ThrowingChild'),
      }),
    );
  });
});
