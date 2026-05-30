import { PRODUCT_NAME } from '../product';
import { useBrand, type BrandMode } from './BrandProvider';

interface BrandLogoProps {
  alt: string;
  className: string;
  src: string;
}

export function getBrandLogoProps(mode: BrandMode): BrandLogoProps {
  if (mode === 'pwc') {
    return { src: '/logo-pwc.svg', alt: 'PwC', className: 'brand-logo brand-logo-pwc' };
  }
  return { src: '/logo.svg', alt: PRODUCT_NAME, className: 'brand-logo brand-logo-neutral' };
}

export function BrandLogo() {
  const { mode } = useBrand();
  const props = getBrandLogoProps(mode);

  return <img {...props} />;
}
