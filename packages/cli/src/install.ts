import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentSkillDir, detectAgents, type AgentTarget } from './agents.js';
import { downloadAndVerify } from './download.js';
import { extractZip } from './extract.js';
import { recordInstall } from './lockfile.js';
import { getSkillDetail, resolveDownload } from './registry-client.js';

export interface InstallSkillOptions {
  version?: string;
  global?: boolean;
  agent?: 'claude' | 'codex' | 'both';
  token?: string;
}

export interface InstalledLocation {
  agent: AgentTarget;
  dir: string;
  files: string[];
}

export interface InstallSkillResult {
  owner: string;
  name: string;
  version: string;
  contentHash: string;
  sourceUrl: string;
  yanked: boolean;
  locations: InstalledLocation[];
}

function formatYankRefusal(
  owner: string,
  name: string,
  version: string,
  reason?: string,
): string {
  const base = `Refusing to install ${owner}/${name}@${version}: version is yanked`;
  return reason ? `${base} (${reason})` : base;
}

function parseSlug(slug: string): { owner: string; name: string; version?: string } {
  const trimmed = slug.trim();
  const atIdx = trimmed.indexOf('@');
  const target = atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
  const version = atIdx > 0 ? trimmed.slice(atIdx + 1) : undefined;

  const parts = target.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid slug "${slug}". Expected format: owner/name[@version]`);
  }
  if (version === '') {
    throw new Error(`Invalid slug "${slug}". Empty version after '@'`);
  }
  return { owner: parts[0], name: parts[1], version };
}

export async function installSkill(
  slug: string,
  opts: InstallSkillOptions = {},
): Promise<InstallSkillResult> {
  const { owner, name, version: slugVersion } = parseSlug(slug);
  const requestedVersion = opts.version ?? slugVersion;
  const fetchOpts = opts.token ? { token: opts.token } : {};

  const detail = await getSkillDetail(owner, name, fetchOpts);
  const targetVersion = requestedVersion ?? detail.latestVersion;
  const versionEntry = detail.versions?.find((v) => v.version === targetVersion);
  if (!versionEntry) {
    throw new Error(`Version ${targetVersion} not found for ${owner}/${name}`);
  }
  if (versionEntry.yanked) {
    throw new Error(formatYankRefusal(owner, name, targetVersion, versionEntry.yankReason));
  }
  const expectedHash = versionEntry.contentHash;

  const { url, yanked } = await resolveDownload(owner, name, targetVersion, fetchOpts);
  if (yanked) {
    throw new Error(formatYankRefusal(owner, name, targetVersion, versionEntry.yankReason));
  }

  const buf = await downloadAndVerify(url, expectedHash, fetchOpts);

  const global = opts.global ?? false;
  const agents = detectAgents({ explicit: opts.agent });

  const locations: InstalledLocation[] = [];
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, { global });
    await mkdir(dir, { recursive: true });
    const files = await extractZip(buf, dir);
    locations.push({ agent, dir, files });
  }

  const lockRoot = global ? homedir() : process.cwd();
  await mkdir(join(lockRoot, '.agent'), { recursive: true });
  await recordInstall(
    'project',
    global,
    name,
    `registry:${owner}/${name}`,
    targetVersion,
    undefined,
    { contentHash: expectedHash, sourceUrl: url },
  );

  return {
    owner,
    name,
    version: targetVersion,
    contentHash: expectedHash,
    sourceUrl: url,
    yanked,
    locations,
  };
}
