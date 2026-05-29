import Conf from 'conf';
import { homedir } from 'os';
import { join } from 'path';
import {
  getConfigSecret,
  storeConfigSecret,
  type ConfigSecretKey,
} from './auth/token-store.js';

interface Config {
  registry?: string;
  token?: string;
  githubToken?: string;
  defaultTarget: 'cursor' | 'claude' | 'project';
}

type ConfigKey = keyof Config;

const SECRET_CONFIG_KEYS = new Set<ConfigKey>(['token', 'githubToken']);

const config = new Conf<Config>({
  projectName: 'asr',
  ...(process.env.ASR_CONFIG_HOME ? { cwd: process.env.ASR_CONFIG_HOME } : {}),
  defaults: {
    defaultTarget: 'project',
  },
});

export function getConfig(): Config {
  return {
    registry: config.get('registry'),
    defaultTarget: config.get('defaultTarget'),
  };
}

async function getMigratedSecret(key: ConfigSecretKey): Promise<string | undefined> {
  const storedSecret = await getConfigSecret(key);
  if (storedSecret) return storedSecret;

  const plaintextValue = config.get(key);
  if (plaintextValue) {
    await storeConfigSecret(key, plaintextValue);
    config.delete(key);
  }

  return plaintextValue;
}

export async function getConfigWithSecrets(): Promise<Config> {
  return {
    ...getConfig(),
    token: await getMigratedSecret('token'),
    githubToken: await getMigratedSecret('githubToken'),
  };
}

export async function getConfigValue(key: ConfigKey): Promise<string | undefined> {
  if (key === 'token' || key === 'githubToken') {
    return getMigratedSecret(key);
  }

  return config.get(key);
}

export async function setConfig(key: ConfigKey, value: string) {
  if (SECRET_CONFIG_KEYS.has(key)) {
    await storeConfigSecret(key as ConfigSecretKey, value);
    config.delete(key);
    return;
  }

  config.set(key, value);
}

export function redactConfig(config: Config): Config {
  return {
    ...config,
    token: config.token ? '<redacted>' : undefined,
    githubToken: config.githubToken ? '<redacted>' : undefined,
  };
}

export function isSecretConfigKey(key: string): key is ConfigSecretKey {
  return key === 'token' || key === 'githubToken';
}

export function getTargetDir(
  target: 'cursor' | 'claude' | 'project',
  skillName: string,
  global = false
): string {
  const home = homedir();

  if (global) {
    const dirs = {
      cursor: join(home, '.cursor', 'skills', skillName),
      claude: join(home, '.claude', 'skills', skillName),
      project: join(home, '.agent', 'skills', skillName),
    };
    return dirs[target];
  }

  const dirs = {
    cursor: join(process.cwd(), '.cursor', 'skills', skillName),
    claude: join(process.cwd(), '.claude', 'skills', skillName),
    project: join(process.cwd(), '.agent', 'skills', skillName),
  };
  return dirs[target];
}
