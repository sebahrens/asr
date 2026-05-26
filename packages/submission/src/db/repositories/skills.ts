import type { SkillDetail, SkillKind, SkillManifest, SkillSummary, SkillVersion } from '@asr/core';
import { rsortVersions } from '@asr/core';
import type Database from 'better-sqlite3';

export interface ListPublishedSkillsOptions {
  q?: string;
  tag?: string;
  kind?: SkillKind;
  limit?: number;
  offset?: number;
}

export interface ListPublishedSkillsResult {
  items: SkillSummary[];
  nextOffset: number | null;
}

interface PublishedSubmissionRow {
  id: string;
  manifest_json: string;
  content_hash: string;
  submitted_at: string;
  submitted_by: string;
  pr_number: number | null;
  status_json: string;
}

interface PublishedSkillVersion {
  manifest: SkillManifest;
  row: PublishedSubmissionRow;
  status: PublishedStatus;
}

interface PublishedStatus {
  publishedAt?: string;
  mergeCommit?: string;
  approvedBy?: string;
  riskAssessment?: SkillVersion['riskAssessment'];
  skillMd?: string;
}

interface PublishedSkillGroup {
  owner: string;
  name: string;
  versions: PublishedSkillVersion[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function listPublishedSkills(
  db: Database.Database,
  opts: ListPublishedSkillsOptions = {},
): ListPublishedSkillsResult {
  const groups = groupPublishedSkills(readPublishedRows(db))
    .map(toSkillDetail)
    .filter((skill) => matchesFilters(skill, opts))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const limit = normalizeLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  const items = groups.slice(offset, offset + limit).map(toSummary);
  const nextOffset = offset + limit < groups.length ? offset + limit : null;

  return { items, nextOffset };
}

export function getPublishedSkill(
  db: Database.Database,
  owner: string,
  name: string,
): SkillDetail | undefined {
  return groupPublishedSkills(readPublishedRows(db))
    .filter((group) => group.owner === owner && group.name === name)
    .map(toSkillDetail)
    .at(0);
}

function readPublishedRows(db: Database.Database): PublishedSubmissionRow[] {
  return db
    .prepare(
      `
        SELECT
          id,
          manifest_json,
          content_hash,
          submitted_at,
          submitted_by,
          pr_number,
          status_json
        FROM submissions
        WHERE status_phase = 'published'
        ORDER BY submitted_at DESC
      `,
    )
    .all() as PublishedSubmissionRow[];
}

function groupPublishedSkills(rows: PublishedSubmissionRow[]): PublishedSkillGroup[] {
  const groups = new Map<string, PublishedSkillGroup>();

  for (const row of rows) {
    const manifest = parseManifest(row.manifest_json);
    const owner = manifest.author;
    const key = `${owner}\0${manifest.name}`;
    const group = groups.get(key) ?? { owner, name: manifest.name, versions: [] };

    group.versions.push({
      manifest,
      row,
      status: parsePublishedStatus(row.status_json),
    });
    groups.set(key, group);
  }

  return [...groups.values()];
}

function toSkillDetail(group: PublishedSkillGroup): SkillDetail {
  const sortedVersions = sortVersions(group.versions);
  const latest = sortedVersions[0];

  return {
    owner: group.owner,
    name: group.name,
    latestVersion: latest.manifest.version,
    description: latest.manifest.description,
    tags: latest.manifest.tags,
    kind: latest.manifest.kind,
    publishedAt: publishedAtFor(latest),
    downloadCount: 0,
    riskAssessmentLatest: latest.status.riskAssessment ?? 'low',
    manifestLatest: latest.manifest,
    skillMd: latest.status.skillMd,
    versions: sortedVersions.map(toSkillVersion),
  };
}

function sortVersions(versions: PublishedSkillVersion[]): PublishedSkillVersion[] {
  const byVersion = new Map(versions.map((version) => [version.manifest.version, version]));
  return rsortVersions([...byVersion.keys()]).map((version) => byVersion.get(version)!);
}

function toSkillVersion(version: PublishedSkillVersion): SkillVersion {
  return {
    owner: version.manifest.author,
    name: version.manifest.name,
    version: version.manifest.version,
    contentHash: version.row.content_hash,
    publishedAt: publishedAtFor(version),
    publishedBy: version.row.submitted_by,
    approvedBy: version.status.approvedBy ?? null,
    prNumber: version.row.pr_number ?? 0,
    mergeCommit: version.status.mergeCommit ?? '',
    yanked: false,
    riskAssessment: version.status.riskAssessment ?? 'low',
  };
}

function toSummary(skill: SkillDetail): SkillSummary {
  return {
    owner: skill.owner,
    name: skill.name,
    latestVersion: skill.latestVersion,
    description: skill.description,
    tags: skill.tags,
    kind: skill.kind,
    publishedAt: skill.publishedAt,
    downloadCount: skill.downloadCount,
    riskAssessmentLatest: skill.riskAssessmentLatest,
  };
}

function matchesFilters(skill: SkillDetail, opts: ListPublishedSkillsOptions): boolean {
  if (opts.kind && skill.kind !== opts.kind) {
    return false;
  }

  if (opts.tag && !skill.tags.includes(opts.tag)) {
    return false;
  }

  const query = opts.q?.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [
    skill.name,
    skill.description,
    ...skill.tags,
  ].some((value) => value.toLowerCase().includes(query));
}

function publishedAtFor(version: PublishedSkillVersion): string {
  return version.status.publishedAt ?? version.row.submitted_at;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(Math.trunc(offset), 0);
}

function parseManifest(value: string): SkillManifest {
  return JSON.parse(value) as SkillManifest;
}

function parsePublishedStatus(value: string): PublishedStatus {
  return JSON.parse(value) as PublishedStatus;
}
