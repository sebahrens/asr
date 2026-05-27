import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillDetail } from '@asr/core';
import { agentSkillDir, detectAgents, type AgentTarget } from './agents.js';
import { readBundleContents } from './bundle.js';
import { downloadAndVerify } from './download.js';
import { extractZip } from './extract.js';
import {
  getAllInstalled,
  getInstalledSkill,
  recordInstall,
  removeFromLock,
} from './lockfile.js';
import { generatePersonaSkillMd } from './persona.js';
import { assertNoReferenceCycles } from './persona-refs.js';
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

export interface ResolveInstallTargetDeps {
  fetchRegistry: (owner: string, name: string) => Promise<SkillDetail>;
}

export type ResolveInstallTargetResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

export async function resolveInstallTarget(
  deps: ResolveInstallTargetDeps,
  owner: string,
  name: string,
  version?: string,
): Promise<ResolveInstallTargetResult> {
  const detail = await deps.fetchRegistry(owner, name);

  if (version) {
    const entry = detail.versions?.find((v) => v.version === version);
    if (!entry) {
      return { ok: false, reason: `version ${version} not found for ${owner}/${name}` };
    }
    if (entry.yanked) {
      return {
        ok: false,
        reason: `version ${version} was yanked: ${entry.yankReason ?? 'withdrawn'}`,
      };
    }
    return { ok: true, version };
  }

  const latest = detail.latestVersion;
  if (!latest) {
    return { ok: false, reason: `no non-yanked version available for ${owner}/${name}` };
  }
  return { ok: true, version: latest };
}

function buildPersonaContent(
  bundle: Awaited<ReturnType<typeof readBundleContents>>,
  agents: readonly AgentTarget[],
): Partial<Record<AgentTarget, string>> | null {
  const root = bundle.root;
  if (!root || root.manifest.kind !== 'persona') return null;

  const { manifest, body } = root;
  const references = manifest.references ?? [];

  const getRefs = (n: string): readonly string[] => {
    if (n === manifest.name) return references;
    return bundle.references.get(n)?.manifest.references ?? [];
  };
  assertNoReferenceCycles(manifest.name, getRefs);

  const resolved: Record<string, string> = {};
  for (const ref of references) {
    const r = bundle.references.get(ref);
    if (r) resolved[ref] = r.body;
  }

  const out: Partial<Record<AgentTarget, string>> = {};
  for (const agent of agents) {
    out[agent] = generatePersonaSkillMd(manifest, body, resolved, { agent });
  }
  return out;
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

  const bundle = await readBundleContents(buf);
  const personaContent = buildPersonaContent(bundle, agents);

  const locations: InstalledLocation[] = [];
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, { global });
    await mkdir(dir, { recursive: true });
    const files = await extractZip(buf, dir);
    const generated = personaContent?.[agent];
    if (generated !== undefined) {
      await writeFile(join(dir, 'SKILL.md'), generated, 'utf-8');
      if (!files.includes('SKILL.md')) files.push('SKILL.md');
    }
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

export interface UpdateSkillResult {
  owner: string;
  name: string;
  oldVersion: string;
  newVersion: string;
  upToDate: boolean;
  installResult?: InstallSkillResult;
}

export async function updateSkill(
  slug?: string,
  opts: InstallSkillOptions = {},
): Promise<UpdateSkillResult[]> {
  const global = opts.global ?? false;
  const installed = await getAllInstalled('project', global);

  type Target = { owner: string; name: string; currentVersion: string };
  const targets: Target[] = [];

  if (slug) {
    const parsed = parseSlug(slug);
    const entry = installed[parsed.name];
    const expectedSource = `registry:${parsed.owner}/${parsed.name}`;
    if (!entry || entry.source !== expectedSource) {
      throw new Error(`${parsed.owner}/${parsed.name} is not installed from the registry`);
    }
    if (!entry.version) {
      throw new Error(`${parsed.owner}/${parsed.name} has no recorded version`);
    }
    targets.push({ owner: parsed.owner, name: parsed.name, currentVersion: entry.version });
  } else {
    for (const info of Object.values(installed)) {
      if (!info.source.startsWith('registry:') || !info.version) continue;
      const rest = info.source.slice('registry:'.length);
      const [o, n] = rest.split('/');
      if (!o || !n) continue;
      targets.push({ owner: o, name: n, currentVersion: info.version });
    }
  }

  const fetchOpts = opts.token ? { token: opts.token } : {};
  const results: UpdateSkillResult[] = [];

  for (const t of targets) {
    const detail = await getSkillDetail(t.owner, t.name, fetchOpts);
    const latest = detail.latestVersion;

    if (latest === t.currentVersion) {
      console.log(`${t.owner}/${t.name}: up to date`);
      results.push({
        owner: t.owner,
        name: t.name,
        oldVersion: t.currentVersion,
        newVersion: latest,
        upToDate: true,
      });
      continue;
    }

    const installResult = await installSkill(`${t.owner}/${t.name}`, opts);
    console.log(`${t.owner}/${t.name}: ${t.currentVersion} -> ${installResult.version}`);
    results.push({
      owner: t.owner,
      name: t.name,
      oldVersion: t.currentVersion,
      newVersion: installResult.version,
      upToDate: false,
      installResult,
    });
  }

  return results;
}

export interface RemoveSkillOptions {
  global?: boolean;
  agent?: 'claude' | 'codex' | 'both';
}

export interface RemovedLocation {
  agent: AgentTarget;
  dir: string;
  existed: boolean;
}

export interface RemoveSkillResult {
  owner: string;
  name: string;
  locations: RemovedLocation[];
  lockEntryRemoved: boolean;
}

export async function removeSkill(
  slug: string,
  opts: RemoveSkillOptions = {},
): Promise<RemoveSkillResult> {
  const { owner, name } = parseSlug(slug);
  const global = opts.global ?? false;
  const agents = detectAgents({ explicit: opts.agent });

  const locations: RemovedLocation[] = [];
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, { global });
    let existed = false;
    try {
      await stat(dir);
      existed = true;
    } catch {
      existed = false;
    }
    if (existed) {
      await rm(dir, { recursive: true, force: true });
    }
    locations.push({ agent, dir, existed });
  }

  const entry = await getInstalledSkill('project', global, name);
  const lockEntryRemoved = entry !== undefined;
  if (lockEntryRemoved) {
    await removeFromLock('project', global, name);
  }

  return { owner, name, locations, lockEntryRemoved };
}
