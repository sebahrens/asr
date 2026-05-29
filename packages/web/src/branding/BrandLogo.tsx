import { useBrand } from './BrandProvider';

export function BrandLogo() {
  const { mode } = useBrand();
  if (mode === 'pwc') {
    return <img src="/logo-pwc.svg" alt="PwC" className="brand-logo brand-logo-pwc" />;
  }
  return <img src="/logo.svg" alt="asr" className="brand-logo brand-logo-asr" />;
}
