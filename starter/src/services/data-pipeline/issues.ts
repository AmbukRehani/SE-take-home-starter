import type { Issue, IssueCode } from "../../types.js";

export type IssueAction = "normalize" | "warn" | "quarantine" | "drop";

/**
 * Single source of truth for what each issue code means for the row it's
 * attached to. DECISIONS.md quotes this table directly so the code and the
 * write-up can't drift apart.
 */
export const ISSUE_POLICY: Record<IssueCode, IssueAction> = {
  DATE_NORMALIZED: "normalize",
  SEX_NORMALIZED: "normalize",
  RESPONSE_NORMALIZED: "normalize",

  PII_STAFF: "warn",
  SEX_INDICATION_MISMATCH: "warn",

  DATE_AMBIGUOUS: "quarantine",
  DATE_INVALID: "quarantine",
  FUTURE_DATE: "quarantine",
  MISSING_REQUIRED_FIELD: "quarantine",
  AGE_IMPLAUSIBLE: "quarantine",
  WEIGHT_IMPLAUSIBLE: "quarantine",
  RESPONSE_UNKNOWN: "quarantine",
  PII_PATIENT: "quarantine",
  DUPLICATE_CONFLICT: "quarantine",
  STATUS_TRIAL_MISMATCH: "quarantine",
  ENCODING_ARTIFACT: "quarantine",
  MALFORMED_ROW: "quarantine",
  UNKNOWN_TRIAL: "quarantine",
  ENROLLMENT_BEFORE_TRIAL_START: "quarantine",
  VISIT_BEFORE_ENROLLMENT: "quarantine",

  DUPLICATE_EXACT: "drop",
  DUPLICATE_SUPERSEDED: "drop",
};

const ACTION_SEVERITY: Record<IssueAction, number> = {
  normalize: 0,
  warn: 1,
  quarantine: 2,
  drop: 3,
};

/** The row's outcome is the most severe action among its issues. */
export function severestAction(issues: Issue[]): IssueAction {
  let worst: IssueAction = "normalize";
  for (const issue of issues) {
    const action = ISSUE_POLICY[issue.code];
    if (ACTION_SEVERITY[action] > ACTION_SEVERITY[worst]) {
      worst = action;
    }
  }
  return worst;
}
