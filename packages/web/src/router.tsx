import type { RouteObject } from 'react-router-dom';
import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import { RequireRole } from './auth/RequireRole';
import { SessionProvider } from './auth/SessionProvider';
import { ReviewDetail } from './routes/ReviewDetail';
import { ReviewQueue } from './routes/ReviewQueue';

function ErrorPage() {
  return (
    <main>
      <h1>Registry route error</h1>
      <p>The requested registry route could not be rendered.</p>
    </main>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/review',
    element: (
      <SessionProvider>
        <RequireRole allowed={['Compliance', 'Admin']}>
          <ReviewQueue />
        </RequireRole>
      </SessionProvider>
    ),
    errorElement: <ErrorPage />,
  },
  {
    path: '/review/:id',
    element: (
      <SessionProvider>
        <RequireRole allowed={['Compliance', 'Admin']}>
          <ReviewDetail />
        </RequireRole>
      </SessionProvider>
    ),
    errorElement: <ErrorPage />,
  },
  {
    path: '*',
    element: <App />,
    errorElement: <ErrorPage />,
  },
];

export const router = createBrowserRouter(routes);
