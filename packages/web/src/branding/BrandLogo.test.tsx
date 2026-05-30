import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLogo, getBrandLogoProps } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the asr logo when no provider is mounted', () => {
    render(<BrandLogo />);

    expect(screen.getByRole('img', { name: 'asr' })).toHaveAttribute('src', '/logo.svg');
  });

  it('uses the asr wordmark and accessible name', () => {
    expect(getBrandLogoProps('asr')).toEqual({
      src: '/logo.svg',
      alt: 'asr',
      className: 'brand-logo brand-logo-asr',
    });
  });
});
