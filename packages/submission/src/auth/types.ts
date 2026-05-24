export interface Identity {
  sub: string;
  roles: string[];
}

export type AuthVariables = {
  identity: Identity;
};
