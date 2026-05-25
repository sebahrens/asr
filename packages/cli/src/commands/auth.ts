import { Buffer } from 'buffer';
import { Command } from 'commander';
import pc from 'picocolors';
import { clearTokens, getStoredTokens, type StoredTokens } from '../auth/token-store.js';

interface AccessTokenClaims {
  email?: string;
  name?: string;
  preferred_username?: string;
  roles?: unknown;
  scp?: string;
  sub?: string;
  upn?: string;
}

function isAuthDisabled(): boolean {
  const url = process.env.ASR_URL;
  if (!url) return false;

  try {
    return new URL(url).protocol !== 'https:';
  } catch {
    return false;
  }
}

function decodeAccessTokenClaims(accessToken: string): AccessTokenClaims {
  const [, encodedPayload] = accessToken.split('.');
  if (!encodedPayload) return {};

  try {
    const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    return JSON.parse(payload) as AccessTokenClaims;
  } catch {
    return {};
  }
}

function identityFromTokens(tokens: StoredTokens, claims: AccessTokenClaims): string {
  return (
    claims.preferred_username ??
    claims.upn ??
    claims.email ??
    claims.name ??
    claims.sub ??
    tokens.account
  );
}

function rolesFromClaims(claims: AccessTokenClaims): string[] {
  if (Array.isArray(claims.roles)) {
    return claims.roles.filter((role): role is string => typeof role === 'string' && role.length > 0);
  }

  if (typeof claims.roles === 'string' && claims.roles.length > 0) {
    return [claims.roles];
  }

  if (typeof claims.scp === 'string' && claims.scp.length > 0) {
    return claims.scp.split(/\s+/).filter(Boolean);
  }

  return [];
}

export function describeStoredIdentity(tokens: StoredTokens): { identity: string; roles: string[] } {
  const claims = decodeAccessTokenClaims(tokens.accessToken);
  return {
    identity: identityFromTokens(tokens, claims),
    roles: rolesFromClaims(claims),
  };
}

export function registerWhoami(program: Command): void {
  program
    .command('whoami')
    .description('Show signed-in identity and roles')
    .action(async () => {
      if (isAuthDisabled()) {
        console.log(pc.yellow('Not signed in'));
        return;
      }

      const tokens = await getStoredTokens();
      if (!tokens) {
        console.log(pc.yellow('Not signed in'));
        return;
      }

      const { identity, roles } = describeStoredIdentity(tokens);
      const roleText = roles.length > 0 ? roles.join(', ') : 'none';
      console.log(`Signed in as ${pc.green(identity)} (roles: ${roleText})`);
    });
}

export function registerLogout(program: Command): void {
  program
    .command('logout')
    .description('Clear cached authentication tokens')
    .action(async () => {
      await clearTokens();
      console.log(pc.green('Signed out'));
    });
}
