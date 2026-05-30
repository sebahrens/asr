import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration0013SkillVersionRiskAssessment: Migration = {
  id: 13,
  name: 'skill_version_risk_assessment',
  up(db: Database.Database): void {
    const columns = db.pragma('table_info(skill_versions)') as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'risk_assessment')) {
      return;
    }

    db.exec(`
      ALTER TABLE skill_versions
        ADD COLUMN risk_assessment TEXT NOT NULL DEFAULT 'low'
        CHECK(risk_assessment IN ('low','medium','high'));
    `);
  },
};
