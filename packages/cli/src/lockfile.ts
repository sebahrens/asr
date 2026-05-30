import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { LockFile, InstalledSkill } from '@asr/core';

const LOCK_FILE = 'asr.lock.json';
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
type LegacyLockTarget = 'cursor' | 'claude' | 'project';

export async function getLockFilePath(_target: LegacyLockTarget, global: boolean): Promise<string> {
  const root = global ? homedir() : process.cwd();
  return join(root, '.agent', LOCK_FILE);
}

export async function readLockFile(lockPath: string): Promise<LockFile> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: 1, skills: {} };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Lockfile ${lockPath} contains invalid JSON; refusing to overwrite it.`);
    }

    throw error;
  }
}

export async function writeLockFile(lockPath: string, lock: LockFile): Promise<void> {
  const dir = dirname(lockPath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(
    dir,
    `.${basename(lockPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, JSON.stringify(lock, null, 2));
  await rename(tempPath, lockPath);
}

async function updateLockFile(
  lockPath: string,
  update: (lock: LockFile) => void | Promise<void>,
): Promise<void> {
  await withLock(lockPath, async () => {
    const lock = await readLockFile(lockPath);
    await update(lock);
    await writeLockFile(lockPath, lock);
  });
}

async function withLock<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const lockDir = `${lockPath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for lockfile lock ${lockDir}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function recordInstall(
  target: LegacyLockTarget,
  global: boolean,
  skillName: string,
  source: string,
  version?: string,
  commit?: string,
  options?: { contentHash?: string; sourceUrl?: string }
): Promise<void> {
  const lockPath = await getLockFilePath(target, global);

  await updateLockFile(lockPath, (lock) => {
    const now = new Date().toISOString();
    const existing = lock.skills[skillName];

    lock.skills[skillName] = {
      name: skillName,
      source,
      version,
      commit,
      installedAt: existing?.installedAt || now,
      updatedAt: now,
      contentHash: options?.contentHash,
      sourceUrl: options?.sourceUrl,
    };
  });
}

export async function removeFromLock(
  target: LegacyLockTarget,
  global: boolean,
  skillName: string
): Promise<void> {
  const lockPath = await getLockFilePath(target, global);
  await updateLockFile(lockPath, (lock) => {
    delete lock.skills[skillName];
  });
}

export async function getInstalledSkill(
  target: LegacyLockTarget,
  global: boolean,
  skillName: string
): Promise<InstalledSkill | undefined> {
  const lockPath = await getLockFilePath(target, global);
  const lock = await readLockFile(lockPath);
  return lock.skills[skillName];
}

export async function getAllInstalled(
  target: LegacyLockTarget,
  global: boolean
): Promise<Record<string, InstalledSkill>> {
  const lockPath = await getLockFilePath(target, global);
  const lock = await readLockFile(lockPath);
  return lock.skills;
}
