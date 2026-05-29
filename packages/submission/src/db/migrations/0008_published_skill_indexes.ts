import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0008PublishedSkillIndexes: Migration = {
  id: 8,
  name: 'published_skill_indexes',
  up(db: Database.Database): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_submissions_published_owner_name
        ON submissions (
          json_extract(manifest_json, '$.author'),
          json_extract(manifest_json, '$.name'),
          COALESCE(json_extract(status_json, '$.publishedAt'), submitted_at) DESC
        )
        WHERE status_phase = 'published';

      CREATE INDEX IF NOT EXISTS idx_submissions_published_kind
        ON submissions (
          json_extract(manifest_json, '$.kind'),
          COALESCE(json_extract(status_json, '$.publishedAt'), submitted_at) DESC
        )
        WHERE status_phase = 'published';
    `);
  },
};
