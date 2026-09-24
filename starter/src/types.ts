export interface ClinicalTrial {
  id: string;
  name: string;
  sponsor: string;
  phase: "I" | "II" | "III";
  status: "recruiting" | "completed" | "terminated";
  indication: string;
  primaryEndpoint: string;
  enrollment: number;
  startDate: string;
  estimatedCompletionDate: string;
  adverseEventRate: number;
  responseRate: number | null;
  keyFindings: string[];
}

export type AnalysisFocus = "safety" | "efficacy" | "competitive";

export interface TrialListResponse {
  trials: ClinicalTrial[];
  total: number;
}

export interface AnalyzeRequest {
  focus: AnalysisFocus;
}

export interface ErrorResponse {
  error: string;
}

export interface PatientRecord {
  patientId: string;
  trialId: string;
  siteId: string;
  enrollmentDate: string;
  age: number;
  sex: "M" | "F" | "Other";
  weight: number;
  doseLevel: string;
  adverseEvents: string[];
  labNotes: string;
  responseAssessment: string | null;
  lastVisitDate: string;
  status: "active" | "completed" | "withdrawn" | "screen_fail";
}

export type IssueCode =
  | "DATE_NORMALIZED"
  | "DATE_AMBIGUOUS"
  | "DATE_INVALID"
  | "FUTURE_DATE"
  | "MISSING_REQUIRED_FIELD"
  | "AGE_IMPLAUSIBLE"
  | "WEIGHT_IMPLAUSIBLE"
  | "SEX_NORMALIZED"
  | "RESPONSE_NORMALIZED"
  | "RESPONSE_UNKNOWN"
  | "PII_PATIENT"
  | "PII_STAFF"
  | "DUPLICATE_EXACT"
  | "DUPLICATE_SUPERSEDED"
  | "DUPLICATE_CONFLICT"
  | "STATUS_TRIAL_MISMATCH"
  | "SEX_INDICATION_MISMATCH"
  | "ENCODING_ARTIFACT"
  | "MALFORMED_ROW"
  | "UNKNOWN_TRIAL"
  | "ENROLLMENT_BEFORE_TRIAL_START"
  | "VISIT_BEFORE_ENROLLMENT";

export interface Issue {
  code: IssueCode;
  field?: string;
  message: string;
}

export interface PipelineResult {
  clean: PatientRecord[];
  quarantined: Array<{
    record: Record<string, string>;
    reasons: string[];
    sourceLine: number;
    issues: Issue[];
  }>;
  warnings: Array<{ patientId: string; issues: Issue[] }>;
  dropped: Array<{ sourceLine: number; patientId: string; reason: IssueCode }>;
  summary: {
    totalInput: number;
    totalClean: number;
    totalQuarantined: number;
    totalDropped: number;
    issuesFound: Partial<Record<IssueCode, number>>;
  };
}
