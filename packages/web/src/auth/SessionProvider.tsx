import { createContext, type ReactNode } from 'react';

export type SessionRole = 'Submitter' | 'Compliance' | 'Admin';

export interface Session {
  sub: string;
  name: string;
  roles: SessionRole[];
}

export const SessionContext = createContext<Session | undefined>(undefined);

const defaultMockSub = 'dev-compliance';
const defaultMockRoles: SessionRole[] = ['Compliance'];

function readMockRoles(): SessionRole[] {
  const mockRoles = import.meta.env.VITE_MOCK_ROLES as string | undefined;

  if (!mockRoles) {
    return defaultMockRoles;
  }

  return mockRoles
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is SessionRole =>
      role === 'Submitter' || role === 'Compliance' || role === 'Admin',
    );
}

function readMockSession(): Session {
  const sub = import.meta.env.VITE_MOCK_SUB || defaultMockSub;
  const roles = readMockRoles();

  return {
    sub,
    name: sub,
    roles: roles.length > 0 ? roles : defaultMockRoles,
  };
}

interface SessionProviderProps {
  children: ReactNode;
}

export function SessionProvider({ children }: SessionProviderProps) {
  const session = readMockSession();

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}
