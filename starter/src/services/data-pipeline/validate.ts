import { z } from "zod";
import type { ClinicalTrial, Issue, PatientRecord } from "../../types.js";

export interface PlausibilityRanges {
  minAge: number;
  maxAge: number;
  minWeight: number;
  maxWeight: number;
}

// Adult oncology trials: age 18-100, weight 30-250kg. Not clinical truth,
// just configurable defaults - override via PipelineOptions.ranges.
export const DEFAULT_RANGES: PlausibilityRanges = {
  minAge: 18,
  maxAge: 100,
  minWeight: 30,
  maxWeight: 250,
};

export function checkPlausibility(
  age: number | null,
  weight: number | null,
  ranges: PlausibilityRanges
): Issue[] {
  const issues: Issue[] = [];
  if (age !== null && (age < ranges.minAge || age > ranges.maxAge)) {
    issues.push({
      code: "AGE_IMPLAUSIBLE",
      field: "age",
      message: `age=${age} is outside the plausible range [${ranges.minAge}, ${ranges.maxAge}]`,
    });
  }
  if (weight !== null && (weight < ranges.minWeight || weight > ranges.maxWeight)) {
    issues.push({
      code: "WEIGHT_IMPLAUSIBLE",
      field: "weight_kg",
      message: `weight=${weight} is outside the plausible range [${ranges.minWeight}, ${ranges.maxWeight}]`,
    });
  }
  return issues;
}

/** Unknown trial_id, enrollment before trial start, visit before enrollment, or any date after asOf. */
export function checkTrialCrossReference(
  trialId: string,
  enrollmentDate: string | null,
  lastVisitDate: string | null,
  asOf: Date,
  trials: ClinicalTrial[]
): Issue[] {
  const trial = trials.find((t) => t.id === trialId);
  if (!trial) {
    return [
      {
        code: "UNKNOWN_TRIAL",
        field: "trial_id",
        message: `trial_id="${trialId}" does not match any known trial`,
      },
    ];
  }

  const issues: Issue[] = [];

  if (enrollmentDate !== null && enrollmentDate < trial.startDate) {
    issues.push({
      code: "ENROLLMENT_BEFORE_TRIAL_START",
      field: "enrollment_date",
      message: `enrollment_date=${enrollmentDate} is before ${trialId}'s start date ${trial.startDate}`,
    });
  }

  if (
    enrollmentDate !== null &&
    lastVisitDate !== null &&
    lastVisitDate < enrollmentDate
  ) {
    issues.push({
      code: "VISIT_BEFORE_ENROLLMENT",
      field: "last_visit_date",
      message: `last_visit_date=${lastVisitDate} is before enrollment_date=${enrollmentDate}`,
    });
  }

  const asOfIso = asOf.toISOString().slice(0, 10);
  for (const [field, date] of [
    ["enrollment_date", enrollmentDate],
    ["last_visit_date", lastVisitDate],
  ] as const) {
    if (date !== null && date > asOfIso) {
      issues.push({
        code: "FUTURE_DATE",
        field,
        message: `${field}=${date} is after asOf (${asOfIso})`,
      });
    }
  }

  return issues;
}

export function checkStatusAgainstTrial(
  trialId: string,
  status: string,
  trials: ClinicalTrial[]
): Issue[] {
  const trial = trials.find((t) => t.id === trialId);
  if (!trial || status !== "active" || trial.status === "recruiting") {
    return [];
  }
  return [
    {
      code: "STATUS_TRIAL_MISMATCH",
      field: "status",
      message: `patient status is "active" but ${trialId} is "${trial.status}"`,
    },
  ];
}

export function checkSexAgainstIndication(
  trialId: string,
  sex: "M" | "F" | "Other",
  trials: ClinicalTrial[],
  restrictedSubstrings: string[]
): Issue[] {
  const trial = trials.find((t) => t.id === trialId);
  if (!trial) return [];
  const indication = trial.indication.toLowerCase();
  const isMaleOnly = restrictedSubstrings.some((s) => indication.includes(s));
  if (isMaleOnly && sex !== "M") {
    return [
      {
        code: "SEX_INDICATION_MISMATCH",
        field: "sex",
        message: `sex="${sex}" is inconsistent with indication "${trial.indication}"`,
      },
    ];
  }
  return [];
}

const patientRecordSchema = z.object({
  patientId: z.string().min(1),
  trialId: z.string().min(1),
  siteId: z.string().min(1),
  enrollmentDate: z.string(),
  age: z.number(),
  sex: z.enum(["M", "F", "Other"]),
  weight: z.number(),
  doseLevel: z.string(),
  adverseEvents: z.array(z.string()),
  labNotes: z.string(),
  responseAssessment: z.string().nullable(),
  lastVisitDate: z.string(),
  status: z.enum(["active", "completed", "withdrawn", "screen_fail"]),
}) satisfies z.ZodType<PatientRecord>;

/** Builds the final PatientRecord shape. Only called for rows with no missing/invalid fields. */
export function toPatientRecord(candidate: unknown): PatientRecord {
  return patientRecordSchema.parse(candidate);
}
