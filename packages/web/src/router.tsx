import type { RouteObject } from 'react-router-dom';
import { createBrowserRouter } from 'react-router-dom';
import App from './App';

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
    path: '*',
    element: <App />,
    errorElement: <ErrorPage />,
  },
];

export const router = createBrowserRouter(routes);
