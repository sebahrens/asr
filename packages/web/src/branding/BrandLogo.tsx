import { PRODUCT_NAME } from '../product';
import { useBrand, type BrandMode } from './BrandProvider';

interface BrandLogoProps {
  alt: string;
  className: string;
  src: string;
}

export function getBrandLogoProps(mode: BrandMode): BrandLogoProps {
  return { src: '/logo.svg', alt: PRODUCT_NAME, className: `brand-logo brand-logo-${mode}` };
}

export function BrandLogo() {
  const { mode } = useBrand();
  const props = getBrandLogoProps(mode);

  return <img {...props} />;
}
