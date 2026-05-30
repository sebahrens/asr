import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/useSession';
import { BrandLogo } from '../branding/BrandLogo';

interface ReviewAppShellProps {
  current: 'browse' | 'publish' | 'review';
  children: ReactNode;
}

export function ReviewAppShell({ current, children }: ReviewAppShellProps) {
  const session = useSession();
  const canReview = session.roles.some((role) => role === 'Compliance' || role === 'Admin');
  const roleLabel = session.roles.length > 0 ? session.roles.join(', ') : 'Viewer';
  const showSessionBanner = import.meta.env.DEV || session.authMode === 'mock';
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [current]);

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <Link className="logo" to="/" aria-label="Home">
            <BrandLogo />
          </Link>
          <nav className="primary-nav" aria-label="Primary navigation">
            <Link to="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</Link>
            <Link to="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</Link>
            {canReview ? (
              <Link to="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</Link>
            ) : null}
          </nav>
          <button
            type="button"
            className="mobile-nav-toggle"
            aria-label={mobileOpen ? 'Close primary navigation' : 'Open primary navigation'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-primary-nav"
            onClick={() => setMobileOpen((open) => !open)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
          <div className="app-topbar-right">
            {showSessionBanner ? (
              <div
                className="mock-auth-banner"
                role="status"
                aria-label={`${session.authMode === 'mock' ? 'Development mock auth' : 'Signed in'} session for ${session.sub} with ${roleLabel} role`}
              >
                <span className="mock-auth-label">{session.authMode === 'mock' ? 'Dev mock auth' : 'Signed in'}</span>
                <span className="mock-auth-identity">{session.sub}</span>
                <span className="mock-auth-role">{roleLabel}</span>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {mobileOpen ? (
        <div className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)}>
          <aside
            id="mobile-primary-nav"
            className="mobile-nav-panel"
            aria-label="Mobile primary navigation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-nav-header">
              <BrandLogo />
              <button
                type="button"
                className="mobile-nav-close"
                aria-label="Close primary navigation"
                onClick={() => setMobileOpen(false)}
              >
                <span aria-hidden="true" />
                <span aria-hidden="true" />
              </button>
            </div>
            <nav className="mobile-nav-links" aria-label="Mobile navigation links">
              <Link to="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</Link>
              <Link to="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</Link>
              {canReview ? (
                <Link to="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</Link>
              ) : null}
            </nav>
            {showSessionBanner ? (
              <div className="mobile-session-summary" aria-label={`${session.authMode === 'mock' ? 'Development mock auth' : 'Signed in'} session for ${session.sub} with ${roleLabel} role`}>
                <span>{session.authMode === 'mock' ? 'Dev mock auth' : 'Signed in'}</span>
                <strong>{session.sub}</strong>
                <small>{roleLabel}</small>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
      {children}
    </>
  );
}
