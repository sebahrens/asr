export interface Identity {
  sub: string;
  roles: string[];
  tokenExpiresAt?: number;
}

export type AuthVariables = {
  identity: Identity;
};
