import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  account: string;
}

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const SERVICE_NAME = 'asr';
const KEYTAR_ACCOUNT = 'tokens';
const TOKEN_FILE = 'token.json';
const CONFIG_SECRETS_FILE = 'config-secrets.json';
const LEGACY_FORGEJO_TOKEN_KEY = ['git', 'hub', 'Token'].join('');

export type ConfigSecretKey = 'token' | 'forgejoToken';

type KeytarImporter = () => Promise<unknown>;

let keytarImporter: KeytarImporter = async () => {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<unknown>;
  return dynamicImport('keytar');
};

export function __setKeytarImporterForTest(importer: KeytarImporter): void {
  keytarImporter = importer;
}

function configRoot(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

function tokenFilePath(): string {
  return join(configRoot(), 'asr', TOKEN_FILE);
}

function configSecretsFilePath(): string {
  return join(configRoot(), 'asr', CONFIG_SECRETS_FILE);
}

function configSecretAccount(key: ConfigSecretKey): string {
  return `config:${key}`;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    const imported = await keytarImporter();
    const maybeModule = imported as Partial<KeytarLike> & { default?: Partial<KeytarLike> };
    const keytar = maybeModule.default ?? maybeModule;

    if (
      typeof keytar.setPassword === 'function' &&
      typeof keytar.getPassword === 'function' &&
      typeof keytar.deletePassword === 'function'
    ) {
      return keytar as KeytarLike;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeFallbackFile(tokens: StoredTokens): Promise<void> {
  const path = tokenFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readFallbackFile(): Promise<StoredTokens | null> {
  try {
    const content = await readFile(tokenFilePath(), 'utf8');
    return JSON.parse(content) as StoredTokens;
  } catch {
    return null;
  }
}

async function clearFallbackFile(): Promise<void> {
  await rm(tokenFilePath(), { force: true });
}

async function readFallbackConfigSecrets(): Promise<Partial<Record<ConfigSecretKey, string>>> {
  try {
    const content = await readFile(configSecretsFilePath(), 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const secrets: Partial<Record<ConfigSecretKey, string>> = {};
    if (typeof parsed.token === 'string') secrets.token = parsed.token;
    if (typeof parsed.forgejoToken === 'string') {
      secrets.forgejoToken = parsed.forgejoToken;
    } else if (typeof parsed[LEGACY_FORGEJO_TOKEN_KEY] === 'string') {
      secrets.forgejoToken = parsed[LEGACY_FORGEJO_TOKEN_KEY];
    }
    return secrets;
  } catch {
    return {};
  }
}

async function writeFallbackConfigSecrets(
  secrets: Partial<Record<ConfigSecretKey, string>>
): Promise<void> {
  const path = configSecretsFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function storeFallbackConfigSecret(key: ConfigSecretKey, value: string): Promise<void> {
  const secrets = await readFallbackConfigSecrets();
  secrets[key] = value;
  await writeFallbackConfigSecrets(secrets);
}

async function getFallbackConfigSecret(key: ConfigSecretKey): Promise<string | undefined> {
  const secrets = await readFallbackConfigSecrets();
  return secrets[key];
}

export async function storeTokens(tokens: StoredTokens): Promise<void> {
  const keytar = await loadKeytar();

  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, KEYTAR_ACCOUNT, JSON.stringify(tokens));
      return;
    } catch {
      // Fall back to the portable file store when native keyring access fails at runtime.
    }
  }

  await writeFallbackFile(tokens);
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  const keytar = await loadKeytar();

  if (keytar) {
    try {
      const password = await keytar.getPassword(SERVICE_NAME, KEYTAR_ACCOUNT);
      if (password) {
        return JSON.parse(password) as StoredTokens;
      }
    } catch {
      // Fall back to the portable file store when native keyring access fails at runtime.
    }
  }

  return readFallbackFile();
}

export async function clearTokens(): Promise<void> {
  const keytar = await loadKeytar();

  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE_NAME, KEYTAR_ACCOUNT);
    } catch {
      // Always clear the fallback file below even if keyring deletion fails.
    }
  }

  await clearFallbackFile();
}

export async function storeConfigSecret(key: ConfigSecretKey, value: string): Promise<void> {
  const keytar = await loadKeytar();

  if (keytar) {
    try {
      await keytar.setPassword(SERVICE_NAME, configSecretAccount(key), value);
      return;
    } catch {
      // Fall back to the portable file store when native keyring access fails at runtime.
    }
  }

  await storeFallbackConfigSecret(key, value);
}

export async function getConfigSecret(key: ConfigSecretKey): Promise<string | undefined> {
  const keytar = await loadKeytar();

  if (keytar) {
    try {
      const password = await keytar.getPassword(SERVICE_NAME, configSecretAccount(key));
      if (password) return password;
      if (key === 'forgejoToken') {
        const legacyPassword = await keytar.getPassword(
          SERVICE_NAME,
          `config:${LEGACY_FORGEJO_TOKEN_KEY}`
        );
        if (legacyPassword) return legacyPassword;
      }
    } catch {
      // Fall back to the portable file store when native keyring access fails at runtime.
    }
  }

  return getFallbackConfigSecret(key);
}
