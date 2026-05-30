import type { SkillDetail, SkillKind, SkillManifest, SkillSummary, SkillVersion } from '@asr/core';
import { rsortVersions } from '@asr/core';
import type Database from 'better-sqlite3';

export interface ListPublishedSkillsOptions {
  q?: string;
  tag?: string;
  tags?: string[];
  owner?: string;
  kind?: SkillKind;
  limit?: number;
  offset?: number;
}

export interface ListPublishedSkillsResult {
  items: SkillSummary[];
  nextOffset: number | null;
}

interface PublishedSubmissionRow {
  owner: string;
  id: string;
  manifest_json: string;
  content_hash: string;
  submitted_at: string;
  submitted_by: string;
  pr_number: number | null;
  status_json: string;
  risk_assessment: SkillVersion['riskAssessment'];
  yanked_at: string | null;
  yank_reason: string | null;
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
  yankedAt?: string;
  yankReason?: string;
}

interface PublishedSkillGroup {
  owner: string;
  name: string;
  versions: PublishedSkillVersion[];
}

interface PublishedSkillKeyRow {
  owner: string;
  name: string;
  published_at: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function listPublishedSkills(
  db: Database.Database,
  opts: ListPublishedSkillsOptions = {},
): ListPublishedSkillsResult {
  const limit = normalizeLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  const keys = readPublishedSkillKeys(db, opts, limit + 1, offset);
  const pageKeys = keys.slice(0, limit);
  const keyOrder = new Map(
    pageKeys.map((key, index) => [`${key.owner}\0${key.name}`, index]),
  );
  const items = groupPublishedSkills(readPublishedRowsForSkillKeys(db, pageKeys))
    .map(toSkillDetail)
    .sort((a, b) => {
      const aIndex = keyOrder.get(`${a.owner}\0${a.name}`) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = keyOrder.get(`${b.owner}\0${b.name}`) ?? Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    })
    .map(toSummary);
  const nextOffset = keys.length > limit ? offset + limit : null;

  return { items, nextOffset };
}

export function getPublishedSkill(
  db: Database.Database,
  owner: string,
  name: string,
): SkillDetail | undefined {
  return groupPublishedSkills(readPublishedRowsForSkill(db, owner, name))
    .map(toSkillDetail)
    .at(0);
}

export interface PublishedSkillVersionRecord {
  manifest: SkillManifest;
  skillMd?: string;
  skillVersion: SkillVersion;
}

export function getPublishedSkillVersion(
  db: Database.Database,
  owner: string,
  name: string,
  version?: string,
): PublishedSkillVersionRecord | undefined {
  const rows =
    version === undefined
      ? readPublishedRowsForSkill(db, owner, name)
      : readPublishedRowsForSkillVersion(db, owner, name, version);
  const group = groupPublishedSkills(rows).at(0);
  if (!group) {
    return undefined;
  }

  const sortedVersions = sortVersions(group.versions);
  const target =
    version === undefined
      ? sortedVersions.find((entry) => entry.row.yanked_at === null)
      : sortedVersions.find((entry) => entry.manifest.version === version);
  if (!target) {
    return undefined;
  }

  return {
    manifest: target.manifest,
    skillMd: target.status.skillMd,
    skillVersion: toSkillVersion(target),
  };
}

function readPublishedSkillKeys(
  db: Database.Database,
  opts: ListPublishedSkillsOptions,
  limit: number,
  offset: number,
): PublishedSkillKeyRow[] {
  const filters = buildPublishedSkillFilters(opts);
  return db
    .prepare(
    `
        SELECT
          owner,
          name,
          MAX(published_at) AS published_at
        FROM (
          SELECT
            sv.owner AS owner,
            json_extract(submissions.manifest_json, '$.name') AS name,
            COALESCE(
              json_extract(submissions.status_json, '$.publishedAt'),
              submissions.submitted_at
            ) AS published_at,
            submissions.manifest_json
          FROM submissions
          JOIN skill_versions sv
            ON sv.submission_id = submissions.id
          WHERE submissions.status_phase = 'published'
            ${filters.sql}
        )
        GROUP BY owner, name
        ORDER BY published_at DESC, owner ASC, name ASC
        LIMIT ? OFFSET ?
      `,
    )
    .all(...filters.params, limit, offset) as PublishedSkillKeyRow[];
}

function readPublishedRowsForSkillKeys(
  db: Database.Database,
  keys: PublishedSkillKeyRow[],
): PublishedSubmissionRow[] {
  if (keys.length === 0) {
    return [];
  }

  const clauses = keys
    .map(
      () =>
        "(sv.owner = ? AND json_extract(submissions.manifest_json, '$.name') = ?)",
    )
    .join(' OR ');
  const params = keys.flatMap((key) => [key.owner, key.name]);

  return readPublishedRowsWhere(db, `AND (${clauses})`, params);
}

function readPublishedRowsForSkill(
  db: Database.Database,
  owner: string,
  name: string,
): PublishedSubmissionRow[] {
  return readPublishedRowsWhere(
    db,
    `
      AND sv.owner = ?
      AND json_extract(submissions.manifest_json, '$.name') = ?
    `,
    [owner, name],
  );
}

function readPublishedRowsForSkillVersion(
  db: Database.Database,
  owner: string,
  name: string,
  version: string,
): PublishedSubmissionRow[] {
  return readPublishedRowsWhere(
    db,
    `
      AND sv.owner = ?
      AND json_extract(submissions.manifest_json, '$.name') = ?
      AND json_extract(submissions.manifest_json, '$.version') = ?
    `,
    [owner, name, version],
  );
}

function readPublishedRowsWhere(
  db: Database.Database,
  whereSql: string,
  params: unknown[],
): PublishedSubmissionRow[] {
  return db
    .prepare(
      `
        SELECT
          submissions.id,
          sv.owner,
          submissions.manifest_json,
          submissions.content_hash,
          submissions.submitted_at,
          submissions.submitted_by,
          submissions.pr_number,
          submissions.status_json,
          sv.risk_assessment,
          sv.yanked_at,
          sv.yank_reason
        FROM submissions
        JOIN skill_versions sv
          ON sv.submission_id = submissions.id
        WHERE status_phase = 'published'
          ${whereSql}
        ORDER BY COALESCE(json_extract(submissions.status_json, '$.publishedAt'), submissions.submitted_at) DESC
      `,
    )
    .all(...params) as PublishedSubmissionRow[];
}

function buildPublishedSkillFilters(opts: ListPublishedSkillsOptions): {
  sql: string;
  params: unknown[];
} {
  const sql: string[] = [];
  const params: unknown[] = [];

  if (opts.owner) {
    sql.push('AND sv.owner = ?');
    params.push(opts.owner);
  }

  if (opts.kind) {
    sql.push("AND json_extract(submissions.manifest_json, '$.kind') = ?");
    params.push(opts.kind);
  }

  const tags = opts.tags ?? (opts.tag ? [opts.tag] : []);
  for (const tag of tags) {
    sql.push(
      "AND EXISTS (SELECT 1 FROM json_each(submissions.manifest_json, '$.tags') WHERE json_each.value = ?)",
    );
    params.push(tag);
  }

  const query = opts.q?.trim().toLowerCase();
  if (query) {
    sql.push(`
      AND (
        lower(CAST(json_extract(submissions.manifest_json, '$.name') AS TEXT)) LIKE ? ESCAPE '\\'
        OR lower(CAST(json_extract(submissions.manifest_json, '$.description') AS TEXT)) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM json_each(submissions.manifest_json, '$.tags')
          WHERE lower(CAST(json_each.value AS TEXT)) LIKE ? ESCAPE '\\'
        )
      )
    `);
    const pattern = `%${escapeLike(query)}%`;
    params.push(pattern, pattern, pattern);
  }

  return { sql: sql.join('\n'), params };
}

function groupPublishedSkills(rows: PublishedSubmissionRow[]): PublishedSkillGroup[] {
  const groups = new Map<string, PublishedSkillGroup>();

  for (const row of rows) {
    const manifest = parseManifest(row.manifest_json);
    const owner = row.owner;
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
  const latest = sortedVersions.find((version) => version.row.yanked_at === null) ?? sortedVersions[0];

  return {
    owner: group.owner,
    name: group.name,
    latestVersion: latest.manifest.version,
    description: latest.manifest.description,
    tags: latest.manifest.tags,
    kind: latest.manifest.kind,
    publishedAt: publishedAtFor(latest),
    downloadCount: 0,
    riskAssessmentLatest: latest.row.risk_assessment,
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
  const yanked = version.row.yanked_at !== null;

  return {
    owner: version.row.owner,
    name: version.manifest.name,
    version: version.manifest.version,
    contentHash: version.row.content_hash,
    publishedAt: publishedAtFor(version),
    publishedBy: version.row.submitted_by,
    approvedBy: version.status.approvedBy ?? null,
    prNumber: version.row.pr_number ?? 0,
    mergeCommit: version.status.mergeCommit ?? '',
    yanked,
    ...(version.row.yanked_at ? { yankedAt: version.row.yanked_at } : {}),
    ...(version.row.yank_reason ? { yankReason: version.row.yank_reason } : {}),
    riskAssessment: version.row.risk_assessment,
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

function publishedAtFor(version: PublishedSkillVersion): string {
  return version.status.publishedAt ?? version.row.submitted_at;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
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
