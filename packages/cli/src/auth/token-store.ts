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
