import type Database from 'better-sqlite3';
import {
  getSkillVersion,
  insertSkillVersion,
  type InsertSkillVersionRow,
} from './skillVersions.js';
import { type SubmissionStatusUpdate, updateSubmissionStatus } from './submissions.js';

export interface PublishSubmissionVersionInput {
  submissionId: string;
  expectedLockVersion: number;
  status: SubmissionStatusUpdate;
  owner: string;
  skillName: string;
  version: string;
  skillVersion: InsertSkillVersionRow;
}

export function publishSubmissionVersion(
  db: Database.Database,
  input: PublishSubmissionVersionInput,
): boolean {
  return db.transaction(() => {
    const updated = updateSubmissionStatus(db, input.submissionId, input.expectedLockVersion, input.status);
    if (!updated) {
      return false;
    }

    if (!getSkillVersion(db, input.skillName, input.version, input.owner)) {
      insertSkillVersion(db, input.skillVersion);
    }

    return true;
  })();
}
