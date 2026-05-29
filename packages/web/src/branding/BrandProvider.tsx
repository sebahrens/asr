import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type BrandMode = 'asr' | 'pwc';

const STORAGE_KEY = 'asr.brand';

interface BrandContextValue {
  mode: BrandMode;
  setMode: (mode: BrandMode) => void;
  toggle: () => void;
}

const BrandContext = createContext<BrandContextValue | null>(null);

function readInitialMode(): BrandMode {
  if (typeof window === 'undefined') return 'asr';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'pwc' ? 'pwc' : 'asr';
  } catch {
    // localStorage may be unavailable (private mode, sandboxed test env);
    // fall back to the default brand.
    return 'asr';
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<BrandMode>(readInitialMode);

  useEffect(() => {
    document.documentElement.setAttribute('data-brand', mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage may be disabled (private mode); the data-brand attribute
      // still applies for this session.
    }
  }, [mode]);

  const setMode = useCallback((next: BrandMode) => setModeState(next), []);
  const toggle = useCallback(() => setModeState((m) => (m === 'asr' ? 'pwc' : 'asr')), []);

  return (
    <BrandContext.Provider value={{ mode, setMode, toggle }}>{children}</BrandContext.Provider>
  );
}

export function useBrand(): BrandContextValue {
  const ctx = useContext(BrandContext);
  if (!ctx) {
    throw new Error('useBrand must be used inside a <BrandProvider>');
  }
  return ctx;
}
