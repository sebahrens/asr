import { createContext, useContext } from 'react';

export type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return init === undefined ? fetch(input) : fetch(input, init);
}

export const AuthenticatedFetchContext = createContext<AuthenticatedFetch>(
  defaultFetch,
);

export function withBearerAuthorization(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

export function createBearerAuthenticatedFetch(
  getAccessToken: () => Promise<string>,
  baseFetch: AuthenticatedFetch = defaultFetch,
): AuthenticatedFetch {
  return async (input, init) => {
    const accessToken = await getAccessToken();
    return baseFetch(input, withBearerAuthorization(init, accessToken));
  };
}

export function useAuthenticatedFetch(): AuthenticatedFetch {
  return useContext(AuthenticatedFetchContext);
}
