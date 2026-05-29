import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import './index.css';
import { AppErrorBoundary } from './AppErrorBoundary';
import { SessionProvider } from './auth/SessionProvider';
import { BrandProvider } from './branding/BrandProvider';
import { router } from './router';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <SessionProvider>
          <AppErrorBoundary>
            <RouterProvider router={router} />
          </AppErrorBoundary>
        </SessionProvider>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>
);
