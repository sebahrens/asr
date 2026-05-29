import type { RegistryIndex, SkillManifest, SkillSummary, SkillVersion } from '@asr/core';
import { rsortVersions } from '@asr/core';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RegistryIndexOptions {
  path?: string;
  now?: () => Date;
}

export interface RegistryIndexFile {
  content: string;
  etag: string;
  lastModified: Date;
}

interface RegistryIndexRow {
  manifest_json: string;
  published_at: string;
  status_json: string;
}

interface PublishedStatus {
  riskAssessment?: SkillVersion['riskAssessment'];
}

const DEFAULT_REGISTRY_INDEX_PATH = join(process.cwd(), '.asr', 'registry.json');

export function registryIndexPath(path = process.env.REGISTRY_INDEX_PATH): string {
  return path ?? DEFAULT_REGISTRY_INDEX_PATH;
}

export async function regenerateRegistryIndex(
  db: Database.Database,
  options: RegistryIndexOptions = {},
): Promise<RegistryIndexFile> {
  const content = `${JSON.stringify(buildRegistryIndex(db, options.now), null, 2)}\n`;
  const targetPath = registryIndexPath(options.path);
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, targetPath);
  return readRegistryIndexFile(targetPath);
}

export async function readRegistryIndexFile(path?: string): Promise<RegistryIndexFile> {
  const targetPath = registryIndexPath(path);
  const [content, metadata] = await Promise.all([
    readFile(targetPath, 'utf8'),
    stat(targetPath),
  ]);
  return {
    content,
    etag: `"${createHash('sha256').update(content).digest('hex')}"`,
    lastModified: metadata.mtime,
  };
}

export function buildRegistryIndex(
  db: Database.Database,
  now: () => Date = () => new Date(),
): RegistryIndex {
  return {
    generatedAt: now().toISOString(),
    specVersion: '1',
    skills: readLiveSkillSummaries(db),
  };
}

function readLiveSkillSummaries(db: Database.Database): SkillSummary[] {
  const rows = db
    .prepare(
      `
        SELECT
          s.manifest_json AS manifest_json,
          sv.published_at AS published_at,
          s.status_json   AS status_json
        FROM skill_versions sv
        JOIN submissions s ON s.id = sv.submission_id
        WHERE sv.yanked_at IS NULL
          AND s.status_phase = 'published'
        ORDER BY sv.published_at DESC
      `,
    )
    .all() as RegistryIndexRow[];

  const bySkill = new Map<string, Array<RegistryIndexRow & { manifest: SkillManifest }>>();
  for (const row of rows) {
    const manifest = JSON.parse(row.manifest_json) as SkillManifest;
    const key = `${manifest.author}\0${manifest.name}`;
    const versions = bySkill.get(key) ?? [];
    versions.push({ ...row, manifest });
    bySkill.set(key, versions);
  }

  return [...bySkill.values()]
    .map((versions) => {
      const latestVersion = rsortVersions(versions.map((row) => row.manifest.version))[0];
      const latest = versions.find((row) => row.manifest.version === latestVersion) ?? versions[0]!;
      const status = JSON.parse(latest.status_json) as PublishedStatus;
      return {
        owner: latest.manifest.author,
        name: latest.manifest.name,
        latestVersion: latest.manifest.version,
        description: latest.manifest.description,
        tags: latest.manifest.tags,
        kind: latest.manifest.kind,
        publishedAt: latest.published_at,
        downloadCount: 0,
        riskAssessmentLatest: status.riskAssessment ?? 'low',
      };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
