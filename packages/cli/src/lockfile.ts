import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { LockFile, InstalledSkill } from '@asr/core';

const LOCK_FILE = 'asr.lock.json';
type LegacyLockTarget = 'cursor' | 'claude' | 'project';

export async function getLockFilePath(_target: LegacyLockTarget, global: boolean): Promise<string> {
  const root = global ? homedir() : process.cwd();
  return join(root, '.agent', LOCK_FILE);
}

export async function readLockFile(lockPath: string): Promise<LockFile> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { version: 1, skills: {} };
  }
}

export async function writeLockFile(lockPath: string, lock: LockFile): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock, null, 2));
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
  const lock = await readLockFile(lockPath);

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

  await writeLockFile(lockPath, lock);
}

export async function removeFromLock(
  target: LegacyLockTarget,
  global: boolean,
  skillName: string
): Promise<void> {
  const lockPath = await getLockFilePath(target, global);
  const lock = await readLockFile(lockPath);
  delete lock.skills[skillName];
  await writeLockFile(lockPath, lock);
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
