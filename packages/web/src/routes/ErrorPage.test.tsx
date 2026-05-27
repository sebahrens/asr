import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorPage } from './ErrorPage';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ErrorPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ErrorPage', () => {
  it('explains the required role for a 403 with a single required role', () => {
    renderAt('/error?code=403&roles=Compliance');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /you do not have permission/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/requires the Compliance role/);
  });

  it('lists every required role for a 403 with multiple required roles', () => {
    renderAt('/error?code=403&roles=Compliance%2CAdmin');

    expect(screen.getByRole('alert')).toHaveTextContent(/requires Compliance or Admin role/);
  });

  it('shows a dev-mode hint about VITE_MOCK_ROLES for 403 in dev builds', () => {
    renderAt('/error?code=403&roles=Compliance');

    if (import.meta.env.DEV) {
      expect(screen.getByText(/VITE_MOCK_ROLES/)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(/VITE_MOCK_ROLES/)).not.toBeInTheDocument();
    }
  });

  it('renders a not-found page when code=404', () => {
    renderAt('/error?code=404');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/page not found/i);
    expect(screen.queryByText(/VITE_MOCK_ROLES/)).not.toBeInTheDocument();
  });

  it('renders a generic error when no code is provided', () => {
    renderAt('/error');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/something went wrong/i);
  });

  it('provides a link back to browse', () => {
    renderAt('/error?code=403&roles=Compliance');

    expect(screen.getByRole('link', { name: /browse skills/i })).toHaveAttribute('href', '/');
  });
});
