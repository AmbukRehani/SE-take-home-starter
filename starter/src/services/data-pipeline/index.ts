import { readFile } from "node:fs/promises";
import type { ClinicalTrial, Issue, IssueCode, PatientRecord, PipelineResult } from "../../types.js";
import { trials as defaultTrials } from "../../data.js";
import { parseRows } from "./parse.js";
import {
  normalizeAdverseEvents,
  normalizeResponse,
  normalizeSex,
  parseFlexibleDate,
  parseRequiredNumber,
} from "./normalize.js";
import { redactText } from "./redact.js";
import { resolveDuplicates, type WorkingRow } from "./dedupe.js";
import {
  DEFAULT_RANGES,
  checkPlausibility,
  checkSexAgainstIndication,
  checkStatusAgainstTrial,
  checkTrialCrossReference,
  toPatientRecord,
  type PlausibilityRanges,
} from "./validate.js";
import { severestAction } from "./issues.js";

export { PipelineInputError } from "./parse.js";

export interface PipelineOptions {
  trials?: ClinicalTrial[];
  asOf?: Date;
  ranges?: Partial<PlausibilityRanges>;
  slashDateOrder?: "MDY" | "DMY";
  /** Indications containing any of these (case-insensitive) substrings are male-only. Default: ["prostate"]. */
  sexRestrictedIndications?: string[];
}

function buildWorkingRow(
  sourceLine: number,
  fields: Record<string, string>,
  baseIssues: Issue[],
  slashDateOrder: "MDY" | "DMY" | undefined
): WorkingRow {
  const issues: Issue[] = [...baseIssues];

  const patientId = fields["patient_id"] ?? "";
  if (patientId === "") {
    issues.push({
      code: "MISSING_REQUIRED_FIELD",
      field: "patient_id",
      message: "patient_id is missing",
    });
  }

  const enrollment = parseFlexibleDate(
    fields["enrollment_date"] ?? "",
    "enrollment_date",
    slashDateOrder
  );
  if (enrollment.issue) issues.push(enrollment.issue);

  const ageResult = parseRequiredNumber(fields["age"] ?? "", "age");
  if (ageResult.issue) issues.push(ageResult.issue);

  const sexResult = normalizeSex(fields["sex"] ?? "");
  if (sexResult.issue) issues.push(sexResult.issue);

  const weightResult = parseRequiredNumber(fields["weight_kg"] ?? "", "weight_kg");
  if (weightResult.issue) issues.push(weightResult.issue);

  const adverseEvents = normalizeAdverseEvents(fields["adverse_events"] ?? "");

  const labNotesRedaction = redactText(fields["lab_notes"] ?? "", "lab_notes");
  issues.push(...labNotesRedaction.issues);

  const responseResult = normalizeResponse(fields["response_assessment"] ?? "");
  if (responseResult.issue) issues.push(responseResult.issue);

  const lastVisit = parseFlexibleDate(
    fields["last_visit_date"] ?? "",
    "last_visit_date",
    slashDateOrder
  );
  if (lastVisit.issue) issues.push(lastVisit.issue);

  return {
    sourceLine,
    issues,
    patientId,
    trialId: fields["trial_id"] ?? "",
    siteId: fields["site_id"] ?? "",
    enrollmentDate: enrollment.iso,
    age: ageResult.value,
    sex: sexResult.value,
    weight: weightResult.value,
    doseLevel: fields["dose_level"] ?? "",
    adverseEvents,
    labNotes: labNotesRedaction.text,
    responseAssessment: responseResult.value,
    lastVisitDate: lastVisit.iso,
    status: fields["status"] ?? "",
    redactedFields: { ...fields, lab_notes: labNotesRedaction.text },
  };
}

function countIssue(counts: Partial<Record<IssueCode, number>>, code: IssueCode): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

/** Pure and synchronous; the main entry point tests call. */
export function runPipeline(csvText: string, options: PipelineOptions = {}): PipelineResult {
  const trials = options.trials ?? defaultTrials;
  const asOf = options.asOf ?? new Date();
  const ranges: PlausibilityRanges = { ...DEFAULT_RANGES, ...options.ranges };
  const restrictedIndications = (
    options.sexRestrictedIndications ?? ["prostate"]
  ).map((s) => s.toLowerCase());

  const rawRows = parseRows(csvText);
  const totalInput = rawRows.length;

  const workingRows = rawRows.map((row) =>
    buildWorkingRow(row.sourceLine, row.fields, row.issues, options.slashDateOrder)
  );

  const { kept, dropped } = resolveDuplicates(workingRows);

  const issuesFound: Partial<Record<IssueCode, number>> = {};
  for (const d of dropped) {
    countIssue(issuesFound, d.reason);
    for (const issue of d.issues) countIssue(issuesFound, issue.code);
  }

  const clean: PatientRecord[] = [];
  const warnings: PipelineResult["warnings"] = [];
  const quarantined: PipelineResult["quarantined"] = [];

  for (const row of kept) {
    row.issues.push(
      ...checkTrialCrossReference(row.trialId, row.enrollmentDate, row.lastVisitDate, asOf, trials),
      ...checkStatusAgainstTrial(row.trialId, row.status, trials),
      ...checkSexAgainstIndication(row.trialId, row.sex, trials, restrictedIndications),
      ...checkPlausibility(row.age, row.weight, ranges)
    );

    for (const issue of row.issues) countIssue(issuesFound, issue.code);

    const action = severestAction(row.issues);

    if (action === "quarantine") {
      quarantined.push({
        record: row.redactedFields,
        reasons: row.issues.map((i) => i.message),
        sourceLine: row.sourceLine,
        issues: row.issues,
      });
      continue;
    }

    const record = toPatientRecord({
      patientId: row.patientId,
      trialId: row.trialId,
      siteId: row.siteId,
      enrollmentDate: row.enrollmentDate,
      age: row.age,
      sex: row.sex,
      weight: row.weight,
      doseLevel: row.doseLevel,
      adverseEvents: row.adverseEvents,
      labNotes: row.labNotes,
      responseAssessment: row.responseAssessment,
      lastVisitDate: row.lastVisitDate,
      status: row.status,
    });

    clean.push(record);
    if (action === "warn") {
      warnings.push({ patientId: row.patientId, issues: row.issues });
    }
  }

  const totalClean = clean.length;
  const totalQuarantined = quarantined.length;
  const totalDropped = dropped.length;

  if (totalInput !== totalClean + totalQuarantined + totalDropped) {
    throw new Error(
      `pipeline invariant violated: ${totalInput} input rows but ${totalClean} clean + ${totalQuarantined} quarantined + ${totalDropped} dropped = ${
        totalClean + totalQuarantined + totalDropped
      }`
    );
  }

  return {
    clean,
    quarantined,
    warnings,
    dropped: dropped.map((d) => ({
      sourceLine: d.sourceLine,
      patientId: d.patientId,
      reason: d.reason,
    })),
    summary: {
      totalInput,
      totalClean,
      totalQuarantined,
      totalDropped,
      issuesFound,
    },
  };
}

export async function runPipelineFromFile(
  path: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const csvText = await readFile(path, "utf-8");
  return runPipeline(csvText, options);
}
