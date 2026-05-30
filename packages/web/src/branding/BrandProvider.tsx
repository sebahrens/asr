import { createContext, useContext, type ReactNode } from 'react';

export type BrandMode = 'pwc' | 'neutral';

interface BrandContextValue {
  mode: BrandMode;
}

const defaultBrandContext: BrandContextValue = { mode: 'neutral' };

const BrandContext = createContext<BrandContextValue>(defaultBrandContext);

export function BrandProvider({ children }: { children: ReactNode }) {
  return <BrandContext.Provider value={{ mode: 'neutral' }}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
