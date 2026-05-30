import { Buffer } from 'buffer';
import { Command } from 'commander';
import pc from 'picocolors';
import { pollForToken, requestDeviceCode, type FetchLike } from '../auth/device-code.js';
import { clearTokens, getStoredTokens, storeTokens, type StoredTokens } from '../auth/token-store.js';
import { getApiBaseUrl, isAuthDisabled, isPlaintextRemoteUrl } from '../env.js';

interface AccessTokenClaims {
  email?: string;
  name?: string;
  preferred_username?: string;
  roles?: unknown;
  scp?: string;
  sub?: string;
  upn?: string;
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

interface RegisterLoginOptions {
  fetch?: FetchLike;
}

function formatRoles(roles: string[]): string {
  return roles.length > 0 ? roles.join(', ') : 'none';
}

export function registerLogin(program: Command, opts: RegisterLoginOptions = {}): void {
  program
    .command('login')
    .description('Sign in with Microsoft Entra ID device code flow')
    .action(async () => {
      const baseUrl = getApiBaseUrl();
      if (isAuthDisabled(baseUrl)) {
        console.log(pc.yellow('Authentication is skipped in dev mode'));
        return;
      }
      if (isPlaintextRemoteUrl(baseUrl)) {
        console.warn(pc.yellow('Warning: ASR_URL uses plaintext HTTP for a non-localhost registry.'));
      }

      try {
        const deviceCode = await requestDeviceCode(baseUrl, opts.fetch);
        console.log(`To sign in, visit ${pc.cyan(deviceCode.verificationUri)}`);
        console.log(`Enter code: ${pc.bold(deviceCode.userCode)}`);
        console.log('Waiting for authentication...');

        const tokens = await pollForToken(baseUrl, deviceCode.deviceCode, {
          fetch: opts.fetch,
          initialIntervalSeconds: deviceCode.interval,
        });
        await storeTokens(tokens);

        const { identity, roles } = describeStoredIdentity(tokens);
        console.log(`Logged in as ${pc.green(identity)} (roles: ${formatRoles(roles)})`);
        console.log(pc.dim('Token cached in OS keyring.'));
      } catch (err) {
        console.error(pc.red(String(err)));
        process.exit(1);
      }
    });
}

export function registerWhoami(program: Command): void {
  program
    .command('whoami')
    .description('Show signed-in identity and roles')
    .action(async () => {
      if (process.env.ASR_URL && isAuthDisabled(process.env.ASR_URL)) {
        console.log(pc.yellow('Not signed in'));
        return;
      }

      const tokens = await getStoredTokens();
      if (!tokens) {
        console.log(pc.yellow('Not signed in'));
        return;
      }

      const { identity, roles } = describeStoredIdentity(tokens);
      console.log(`Signed in as ${pc.green(identity)} (roles: ${formatRoles(roles)})`);
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
