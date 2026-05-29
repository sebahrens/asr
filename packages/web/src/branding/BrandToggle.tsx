import { useBrand } from './BrandProvider';

export function BrandToggle() {
  const { mode, toggle } = useBrand();
  const next = mode === 'asr' ? 'PwC' : 'asr';
  return (
    <button
      type="button"
      className="brand-toggle"
      onClick={toggle}
      aria-label={`Switch brand to ${next}`}
      title={`Switch brand to ${next}`}
    >
      <span className="brand-toggle-label">Brand</span>
      <span className={`brand-toggle-pill brand-toggle-pill-${mode}`} aria-hidden="true">
        <span className="brand-toggle-thumb" />
      </span>
      <span className="brand-toggle-value">{mode === 'pwc' ? 'PwC' : 'asr'}</span>
    </button>
  );
}
