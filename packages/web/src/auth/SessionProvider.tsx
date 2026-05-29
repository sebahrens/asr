import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import {
  BrowserCacheLocation,
  InteractionStatus,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from '@azure/msal-browser';
import { MsalProvider, useAccount, useMsal } from '@azure/msal-react';

export type SessionRole = 'Submitter' | 'Compliance' | 'Admin';
export type AuthMode = 'mock' | 'msal';

export interface Session {
  sub: string;
  name: string;
  roles: SessionRole[];
  authMode?: AuthMode;
}

export const SessionContext = createContext<Session | undefined>(undefined);

const defaultMockSub = 'dev-compliance';
const defaultMockRoles: SessionRole[] = ['Submitter', 'Compliance'];
const supportedRoles: SessionRole[] = ['Submitter', 'Compliance', 'Admin'];
const supportedAuthModes: AuthMode[] = ['mock', 'msal'];

function readMockRoles(): SessionRole[] {
  const mockRoles = import.meta.env.VITE_MOCK_ROLES as string | undefined;

  if (!mockRoles) {
    return defaultMockRoles;
  }

  return mockRoles
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is SessionRole => supportedRoles.includes(role as SessionRole));
}

function readMockSession(): Session {
  assertMockAuthAllowed();

  const sub = import.meta.env.VITE_MOCK_SUB || defaultMockSub;
  const roles = readMockRoles();

  return {
    sub,
    name: sub,
    roles: roles.length > 0 ? roles : defaultMockRoles,
    authMode: 'mock',
  };
}

interface SessionProviderProps {
  children: ReactNode;
}

function readAuthMode(): AuthMode {
  const configuredMode = import.meta.env.VITE_AUTH_MODE as string | undefined;

  if (supportedAuthModes.includes(configuredMode as AuthMode)) {
    return configuredMode as AuthMode;
  }

  return import.meta.env.DEV ? 'mock' : 'msal';
}

function assertMockAuthAllowed(): void {
  if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK_AUTH === 'true') {
    return;
  }

  throw new Error('Mock auth is disabled outside dev builds. Configure VITE_AUTH_MODE=msal for production.');
}

function readLoginScopes(): string[] {
  const configuredScopes = import.meta.env.VITE_ENTRA_SCOPES as string | undefined;
  if (!configuredScopes) {
    return ['openid', 'profile', 'email'];
  }

  return configuredScopes
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function readMsalConfig(): Configuration {
  const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined;
  if (!clientId) {
    throw new Error('VITE_ENTRA_CLIENT_ID is required when VITE_AUTH_MODE=msal.');
  }

  const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID || 'organizations';
  const authority = import.meta.env.VITE_ENTRA_AUTHORITY || `https://login.microsoftonline.com/${tenantId}`;

  return {
    auth: {
      clientId,
      authority,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: BrowserCacheLocation.SessionStorage,
    },
  };
}

function getClaimArray(account: AccountInfo, claim: string): string[] {
  const claims = account.idTokenClaims as Record<string, unknown> | undefined;
  const value = claims?.[claim];

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sessionFromAccount(account: AccountInfo): Session {
  const claims = account.idTokenClaims as Record<string, unknown> | undefined;
  const sub = typeof claims?.sub === 'string' ? claims.sub : account.localAccountId || account.homeAccountId;
  const preferredName = typeof claims?.preferred_username === 'string' ? claims.preferred_username : account.username;
  const roles = getClaimArray(account, 'roles')
    .filter((role): role is SessionRole => supportedRoles.includes(role as SessionRole));

  return {
    sub,
    name: account.name || preferredName || sub,
    roles,
    authMode: 'msal',
  };
}

function MockSessionProvider({ children }: SessionProviderProps) {
  const session = readMockSession();

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

function MsalSessionBridge({ children }: SessionProviderProps) {
  const { instance, accounts, inProgress } = useMsal();
  const account = useAccount(accounts[0] ?? null);
  const loginScopes = useMemo(readLoginScopes, []);

  useEffect(() => {
    if (account || accounts.length > 0 || inProgress !== InteractionStatus.None) {
      return;
    }

    void instance.loginRedirect({ scopes: loginScopes });
  }, [account, accounts.length, inProgress, instance, loginScopes]);

  if (!account) {
    return (
      <main className="auth-redirect-state">
        <p>Redirecting to sign in...</p>
      </main>
    );
  }

  return (
    <SessionContext.Provider value={sessionFromAccount(account)}>
      {children}
    </SessionContext.Provider>
  );
}

function MsalAuthProvider({ children }: SessionProviderProps) {
  const instance = useMemo(() => new PublicClientApplication(readMsalConfig()), []);

  return (
    <MsalProvider instance={instance}>
      <MsalSessionBridge>{children}</MsalSessionBridge>
    </MsalProvider>
  );
}

export function AuthProvider({ children }: SessionProviderProps) {
  return readAuthMode() === 'mock'
    ? <MockSessionProvider>{children}</MockSessionProvider>
    : <MsalAuthProvider>{children}</MsalAuthProvider>;
}

export function SessionProvider({ children }: SessionProviderProps) {
  return <AuthProvider>{children}</AuthProvider>;
}
