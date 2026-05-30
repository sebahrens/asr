import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandProvider, useBrand } from './BrandProvider';

function BrandModeProbe() {
  const { mode } = useBrand();
  return <span>{mode}</span>;
}

describe('BrandProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete document.documentElement.dataset.brand;
    cleanup();
  });

  it('sets the root brand attribute to asr', async () => {
    render(
      <BrandProvider>
        <BrandModeProbe />
      </BrandProvider>,
    );

    expect(screen.getByText('asr')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-brand', 'asr'));
  });

  it('ignores stale build-time brand env values', async () => {
    vi.stubEnv('VITE_BRAND', 'pwc');

    render(
      <BrandProvider>
        <BrandModeProbe />
      </BrandProvider>,
    );

    expect(screen.getByText('asr')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-brand', 'asr'));
  });
});
