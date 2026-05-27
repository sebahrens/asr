import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { RequireRole } from './RequireRole';
import { SessionContext, type Session, type SessionRole } from './SessionProvider';

function ErrorLocationProbe() {
  const location = useLocation();
  return (
    <div>
      <div>error page</div>
      <div data-testid="error-search">{location.search}</div>
    </div>
  );
}

function renderWithRoles(roles: SessionRole[]) {
  const session: Session = { sub: 'u1', name: 'u1', roles };

  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={['/protected']}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireRole allowed={['Compliance', 'Admin']}>
                <div>secret</div>
              </RequireRole>
            }
          />
          <Route path="/error" element={<ErrorLocationProbe />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('RequireRole', () => {
  it('renders children when the session has an allowed role', () => {
    renderWithRoles(['Compliance']);

    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(screen.queryByText('error page')).not.toBeInTheDocument();
  });

  it('redirects to /error?code=403 with the required roles when the session lacks an allowed role', () => {
    renderWithRoles(['Submitter']);

    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByText('error page')).toBeInTheDocument();
    expect(screen.getByTestId('error-search').textContent).toBe('?code=403&roles=Compliance%2CAdmin');
  });

  it('renders children when one of multiple session roles is allowed', () => {
    renderWithRoles(['Submitter', 'Admin']);

    expect(screen.getByText('secret')).toBeInTheDocument();
  });
});
