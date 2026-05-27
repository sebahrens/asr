import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { RequireRole } from './RequireRole';
import { SessionContext, type Session, type SessionRole } from './SessionProvider';

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
          <Route path="/error" element={<div>error page</div>} />
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

  it('redirects to /error?code=403 when the session lacks an allowed role', () => {
    renderWithRoles(['Submitter']);

    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByText('error page')).toBeInTheDocument();
  });

  it('renders children when one of multiple session roles is allowed', () => {
    renderWithRoles(['Submitter', 'Admin']);

    expect(screen.getByText('secret')).toBeInTheDocument();
  });
});
