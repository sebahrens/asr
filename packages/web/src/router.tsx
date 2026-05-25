import type { RouteObject } from 'react-router-dom';
import { createBrowserRouter } from 'react-router-dom';
import App from './App';

function ReviewQueuePlaceholder() {
  return (
    <main>
      <h1>Review queue</h1>
      <p>Compliance review queue routing is ready.</p>
    </main>
  );
}

function ReviewDetailPlaceholder() {
  return (
    <main>
      <h1>Review detail</h1>
      <p>Compliance review detail routing is ready.</p>
    </main>
  );
}

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
    path: '/',
    element: <App />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/review',
    element: <ReviewQueuePlaceholder />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/review/:id',
    element: <ReviewDetailPlaceholder />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/error',
    element: <ErrorPage />,
  },
];

export const router = createBrowserRouter(routes);
