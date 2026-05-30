import { createContext, useContext, useEffect, type ReactNode } from 'react';

export type BrandMode = 'pwc' | 'neutral';

interface BrandContextValue {
  mode: BrandMode;
}

const defaultBrandContext: BrandContextValue = { mode: 'pwc' };

const BrandContext = createContext<BrandContextValue>(defaultBrandContext);

function resolveBrandMode(value: string | undefined): BrandMode {
  return value === 'neutral' ? 'neutral' : 'pwc';
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const mode = resolveBrandMode(import.meta.env.VITE_BRAND);

  useEffect(() => {
    document.documentElement.dataset.brand = mode;
  }, [mode]);

  return <BrandContext.Provider value={{ mode }}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
