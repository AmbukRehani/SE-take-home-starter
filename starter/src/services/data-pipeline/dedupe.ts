import type { Issue, IssueCode } from "../../types.js";

/**
 * A row after decode/parse/normalize/redact, before duplicate resolution
 * and final validation. Dates are ISO strings or null (missing/invalid);
 * age/weight are numbers or null (missing/invalid).
 */
export interface WorkingRow {
  sourceLine: number;
  issues: Issue[];
  patientId: string;
  trialId: string;
  siteId: string;
  enrollmentDate: string | null;
  age: number | null;
  sex: "M" | "F" | "Other";
  weight: number | null;
  doseLevel: string;
  adverseEvents: string[];
  labNotes: string;
  responseAssessment: string | null;
  lastVisitDate: string | null;
  status: string;
  redactedFields: Record<string, string>;
}

export interface DroppedRow {
  sourceLine: number;
  patientId: string;
  reason: Extract<IssueCode, "DUPLICATE_EXACT" | "DUPLICATE_SUPERSEDED">;
  /** The dropped row's own issues (e.g. date normalizations), for issue accounting. */
  issues: Issue[];
}

export interface DedupeResult {
  kept: WorkingRow[];
  dropped: DroppedRow[];
}

function baselineKey(row: WorkingRow): string {
  return JSON.stringify([
    row.trialId,
    row.siteId,
    row.enrollmentDate,
    row.age,
    row.sex,
  ]);
}

function fullRowKey(row: WorkingRow): string {
  return JSON.stringify([
    baselineKey(row),
    row.weight,
    row.doseLevel,
    row.adverseEvents,
    row.labNotes,
    row.responseAssessment,
    row.lastVisitDate,
    row.status,
  ]);
}

/**
 * Compares baseline fields (trial_id, site_id, enrollment_date, age, sex)
 * for rows sharing a patient_id. Identical in every field: keep one, drop
 * the rest. Same baseline, different follow-up: keep the row with the
 * latest last_visit_date, drop the rest (a tie is quarantined instead of
 * guessed). Different baseline: this may be two patients sharing an ID, so
 * every version is quarantined rather than dropped.
 */
export function resolveDuplicates(rows: WorkingRow[]): DedupeResult {
  const groups = new Map<string, WorkingRow[]>();
  const kept: WorkingRow[] = [];

  for (const row of rows) {
    if (row.patientId === "") {
      // No ID to group by; MISSING_REQUIRED_FIELD (added upstream) already
      // routes this row to quarantine on its own.
      kept.push(row);
      continue;
    }
    const list = groups.get(row.patientId);
    if (list) {
      list.push(row);
    } else {
      groups.set(row.patientId, [row]);
    }
  }

  const dropped: DroppedRow[] = [];

  for (const [patientId, group] of groups) {
    if (group.length === 1) {
      kept.push(group[0]!);
      continue;
    }

    const baselines = new Set(group.map(baselineKey));
    if (baselines.size > 1) {
      for (const row of group) {
        row.issues.push({
          code: "DUPLICATE_CONFLICT",
          message: `patient_id "${patientId}" appears ${group.length} times with conflicting baseline data (possible ID reuse)`,
        });
        kept.push(row);
      }
      continue;
    }

    const rowKeys = group.map(fullRowKey);
    if (new Set(rowKeys).size === 1) {
      const [first, ...rest] = group;
      kept.push(first!);
      for (const row of rest) {
        dropped.push({
          sourceLine: row.sourceLine,
          patientId,
          reason: "DUPLICATE_EXACT",
          issues: row.issues,
        });
      }
      continue;
    }

    if (group.some((row) => row.lastVisitDate === null)) {
      for (const row of group) {
        row.issues.push({
          code: "DUPLICATE_CONFLICT",
          message: `patient_id "${patientId}" has duplicate rows that can't be ordered by last_visit_date`,
        });
        kept.push(row);
      }
      continue;
    }

    const sorted = [...group].sort((a, b) =>
      (b.lastVisitDate as string).localeCompare(a.lastVisitDate as string)
    );
    const [latest, runnerUp] = sorted as [WorkingRow, WorkingRow];

    if (latest.lastVisitDate === runnerUp.lastVisitDate) {
      for (const row of group) {
        row.issues.push({
          code: "DUPLICATE_CONFLICT",
          message: `patient_id "${patientId}" has duplicate rows tied on last_visit_date`,
        });
        kept.push(row);
      }
      continue;
    }

    kept.push(latest);
    for (const row of sorted.slice(1)) {
      dropped.push({
        sourceLine: row.sourceLine,
        patientId,
        reason: "DUPLICATE_SUPERSEDED",
        issues: row.issues,
      });
    }
  }

  return { kept, dropped };
}
