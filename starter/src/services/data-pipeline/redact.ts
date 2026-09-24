import type { Issue, IssueCode } from "../../types.js";

interface RedactionRule {
  source: string;
  flags: string;
  token: string;
  code: Extract<IssueCode, "PII_PATIENT" | "PII_STAFF">;
  message: string;
}

// Regex is a floor, not a ceiling: production should use a dedicated PHI
// de-identification service. These patterns catch the common, explicit
// cases seen in this kind of free-text field.
const RULES: RedactionRule[] = [
  {
    source: "Patient\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?",
    flags: "g",
    token: "[REDACTED:PATIENT_NAME]",
    code: "PII_PATIENT",
    message: "contained a patient name",
  },
  {
    source: "MRN:?\\s*\\d+",
    flags: "gi",
    token: "[REDACTED:MRN]",
    code: "PII_PATIENT",
    message: "contained an MRN",
  },
  {
    source: "\\b\\d{3}-[\\dX]{2}-\\d{4}\\b",
    flags: "g",
    token: "[REDACTED:SSN]",
    code: "PII_PATIENT",
    message: "contained a partial SSN",
  },
  {
    source: "\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b",
    flags: "g",
    token: "[REDACTED:EMAIL]",
    code: "PII_STAFF",
    message: "contained an email address",
  },
  {
    source: "\\b\\(?\\d{3}\\)?[-.\\s]\\d{3}[-.\\s]\\d{4}\\b",
    flags: "g",
    token: "[REDACTED:PHONE]",
    code: "PII_STAFF",
    message: "contained a phone number",
  },
  {
    source: "(?:Dr\\.|CRA)\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?",
    flags: "g",
    token: "[REDACTED:STAFF_NAME]",
    code: "PII_STAFF",
    message: "contained a staff name",
  },
];

export interface RedactionResult {
  text: string;
  issues: Issue[];
}

/** Replaces PII/PHI matches with typed tokens and reports what was found. */
export function redactText(raw: string, field: string): RedactionResult {
  let text = raw;
  const issues: Issue[] = [];

  for (const rule of RULES) {
    const pattern = new RegExp(rule.source, rule.flags);
    if (!pattern.test(text)) continue;
    text = text.replace(new RegExp(rule.source, rule.flags), rule.token);
    issues.push({ code: rule.code, field, message: `${field} ${rule.message}` });
  }

  return { text, issues };
}
