import { createContext, useContext, useEffect, type ReactNode } from 'react';

export type BrandMode = 'asr';

interface BrandContextValue {
  mode: BrandMode;
}

const defaultBrandContext: BrandContextValue = { mode: 'asr' };

const BrandContext = createContext<BrandContextValue>(defaultBrandContext);

export function BrandProvider({ children }: { children: ReactNode }) {
  const mode: BrandMode = 'asr';

  useEffect(() => {
    document.documentElement.dataset.brand = mode;
  }, [mode]);

  return <BrandContext.Provider value={{ mode }}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
