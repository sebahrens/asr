import { createContext, useContext, type ReactNode } from 'react';

export type BrandMode = 'asr';

interface BrandContextValue {
  mode: BrandMode;
}

const BrandContext = createContext<BrandContextValue | null>(null);

export function BrandProvider({ children }: { children: ReactNode }) {
  return <BrandContext.Provider value={{ mode: 'asr' }}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandContextValue {
  const ctx = useContext(BrandContext);
  if (!ctx) {
    throw new Error('useBrand must be used inside a <BrandProvider>');
  }
  return ctx;
}
