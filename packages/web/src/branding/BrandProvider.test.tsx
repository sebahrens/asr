import { render, screen, waitFor } from '@testing-library/react';
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
  });

  it('defaults to PwC mode and sets the root brand attribute', async () => {
    render(
      <BrandProvider>
        <BrandModeProbe />
      </BrandProvider>,
    );

    expect(screen.getByText('pwc')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-brand', 'pwc'));
  });

  it('uses neutral mode when VITE_BRAND is neutral', async () => {
    vi.stubEnv('VITE_BRAND', 'neutral');

    render(
      <BrandProvider>
        <BrandModeProbe />
      </BrandProvider>,
    );

    expect(screen.getByText('neutral')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-brand', 'neutral'));
  });
});
