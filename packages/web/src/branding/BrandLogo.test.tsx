import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PRODUCT_NAME } from '../product';
import { BrandLogo, getBrandLogoProps } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the neutral wordmark when no provider is mounted', () => {
    render(<BrandLogo />);

    expect(screen.getByRole('img', { name: PRODUCT_NAME })).toHaveAttribute('src', '/logo.svg');
  });

  it('uses the PwC SVG and accessible name in pwc mode', () => {
    expect(getBrandLogoProps('pwc')).toEqual({
      src: '/logo-pwc.svg',
      alt: 'PwC',
      className: 'brand-logo brand-logo-pwc',
    });
  });

  it('uses the neutral product wordmark and accessible name in neutral mode', () => {
    expect(getBrandLogoProps('neutral')).toEqual({
      src: '/logo.svg',
      alt: PRODUCT_NAME,
      className: 'brand-logo brand-logo-neutral',
    });
  });
});
