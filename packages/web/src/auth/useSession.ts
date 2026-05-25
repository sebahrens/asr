import { useContext } from 'react';
import { SessionContext, type Session } from './SessionProvider';

export function useSession(): Session {
  const session = useContext(SessionContext);

  if (!session) {
    throw new Error('useSession must be used within SessionProvider');
  }

  return session;
}
