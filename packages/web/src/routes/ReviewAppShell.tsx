import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/useSession';

interface ReviewAppShellProps {
  current: 'browse' | 'publish' | 'review';
  children: ReactNode;
}

export function ReviewAppShell({ current, children }: ReviewAppShellProps) {
  const session = useSession();
  const canReview = session.roles.some((role) => role === 'Compliance' || role === 'Admin');
  const roleLabel = session.roles.length > 0 ? session.roles.join(', ') : 'Viewer';
  const authLabel = session.authMode === 'mock' ? 'Dev mock auth' : 'Signed in';
  const authDescription = session.authMode === 'mock' ? 'Development mock auth' : 'Signed in';

  return (
    <>
      <div className="brand-stripe" />
      <header>
        <div className="container app-topbar">
          <Link className="logo" to="/" aria-label="asr home">
            <img src="/logo.svg" alt="asr" />
          </Link>
          <nav className="primary-nav" aria-label="Primary navigation">
            <Link to="/" aria-current={current === 'browse' ? 'page' : undefined}>Browse</Link>
            <Link to="/publish" aria-current={current === 'publish' ? 'page' : undefined}>Publish</Link>
            {canReview ? (
              <Link to="/review" aria-current={current === 'review' ? 'page' : undefined}>Review</Link>
            ) : null}
          </nav>
          <div
            className="mock-auth-banner"
            role="status"
            aria-label={`${authDescription} session for ${session.sub} with ${roleLabel} role`}
          >
            <span className="mock-auth-label">{authLabel}</span>
            <span className="mock-auth-identity">{session.sub}</span>
            <span className="mock-auth-role">{roleLabel}</span>
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
