import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { SessionRole } from './SessionProvider';
import { useSession } from './useSession';

interface RequireRoleProps {
  allowed: SessionRole[];
  children: ReactNode;
}

export function RequireRole({ allowed, children }: RequireRoleProps) {
  const session = useSession();
  const allowedSet = new Set<SessionRole>(allowed);
  const hasRole = session.roles.some((role) => allowedSet.has(role));

  if (!hasRole) {
    const rolesParam = encodeURIComponent(allowed.join(','));
    return <Navigate to={`/error?code=403&roles=${rolesParam}`} replace />;
  }

  return <>{children}</>;
}
