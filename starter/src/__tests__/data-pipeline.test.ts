import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  runPipeline,
  runPipelineFromFile,
  PipelineInputError,
} from "../services/data-pipeline/index.js";

const HEADER =
  "patient_id,trial_id,site_id,enrollment_date,age,sex,weight_kg,dose_level,adverse_events,lab_notes,response_assessment,last_visit_date,status";

interface RowInput {
  patient_id?: string;
  trial_id?: string;
  site_id?: string;
  enrollment_date?: string;
  age?: string;
  sex?: string;
  weight_kg?: string;
  dose_level?: string;
  adverse_events?: string;
  lab_notes?: string;
  response_assessment?: string;
  last_visit_date?: string;
  status?: string;
}

const DEFAULT_ROW: Required<RowInput> = {
  patient_id: "PT-100",
  trial_id: "NCT-001",
  site_id: "SITE-A01",
  enrollment_date: "2023-04-01",
  age: "50",
  sex: "M",
  weight_kg: "80",
  dose_level: "400mg BID",
  adverse_events: "fatigue",
  lab_notes: "routine note",
  response_assessment: "stable_disease",
  last_visit_date: "2023-06-01",
  status: "active",
};

const COLUMN_ORDER: (keyof RowInput)[] = [
  "patient_id",
  "trial_id",
  "site_id",
  "enrollment_date",
  "age",
  "sex",
  "weight_kg",
  "dose_level",
  "adverse_events",
  "lab_notes",
  "response_assessment",
  "last_visit_date",
  "status",
];

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Builds a small inline CSV fixture from partial row overrides on top of a valid default row. */
function csv(rows: RowInput[]): string {
  const lines = [HEADER];
  for (const row of rows) {
    const merged = { ...DEFAULT_ROW, ...row };
    lines.push(COLUMN_ORDER.map((key) => csvField(merged[key])).join(","));
  }
  return lines.join("\n") + "\n";
}

const FIXED_ASOF = new Date("2026-09-24");

describe("data-pipeline", () => {
  it("processes the full real file into 42 clean, 8 quarantined, 1 dropped", async () => {
    const result = await runPipelineFromFile("data/incoming_patient_data.csv", {
      asOf: FIXED_ASOF,
    });

    expect(result.summary.totalInput).toBe(51);
    expect(result.summary.totalClean).toBe(42);
    expect(result.summary.totalQuarantined).toBe(8);
    expect(result.summary.totalDropped).toBe(1);
    expect(
      result.summary.totalClean + result.summary.totalQuarantined + result.summary.totalDropped
    ).toBe(result.summary.totalInput);

    const quarantinedIds = result.quarantined.map((q) => q.record["patient_id"]);
    expect(quarantinedIds).toEqual(
      expect.arrayContaining(["", "PT-003", "PT-004", "PT-011", "PT-014", "PT-016", "PT-037", "PT-045"])
    );
    expect(result.quarantined).toHaveLength(8);

    expect(result.dropped).toEqual([
      { sourceLine: 4, patientId: "PT-003", reason: "DUPLICATE_SUPERSEDED" },
    ]);

    expect(result.warnings.map((w) => w.patientId).sort()).toEqual([
      "PT-006",
      "PT-017",
      "PT-021",
      "PT-050",
    ]);
  });

  it("normalizes every supported date format to ISO and flags ambiguous/invalid/future dates", () => {
    const result = runPipeline(
      csv([
        { patient_id: "PT-ISO", enrollment_date: "2023-04-01", last_visit_date: "2025-01-01" },
        { patient_id: "PT-SLASH-YMD", enrollment_date: "2023/11/01", last_visit_date: "2025-01-01" },
        { patient_id: "PT-SLASH-DMY", enrollment_date: "15/05/2024", last_visit_date: "2025-01-01" },
        { patient_id: "PT-SLASH-MDY", enrollment_date: "04/25/2023", last_visit_date: "2025-01-01" },
        { patient_id: "PT-TEXT-MONTH", enrollment_date: "Jun 20 2023", last_visit_date: "2025-01-01" },
        { patient_id: "PT-AMBIGUOUS", enrollment_date: "03/04/2024", last_visit_date: "2025-01-01" },
        { patient_id: "PT-INVALID", enrollment_date: "2023-02-30", last_visit_date: "2025-01-01" },
        { patient_id: "PT-FUTURE", enrollment_date: "2027-01-01", last_visit_date: "2027-02-01" },
      ]),
      { asOf: FIXED_ASOF }
    );

    const clean = new Map(result.clean.map((r) => [r.patientId, r]));
    expect(clean.get("PT-ISO")?.enrollmentDate).toBe("2023-04-01");
    expect(clean.get("PT-SLASH-YMD")?.enrollmentDate).toBe("2023-11-01");
    expect(clean.get("PT-SLASH-DMY")?.enrollmentDate).toBe("2024-05-15");
    expect(clean.get("PT-SLASH-MDY")?.enrollmentDate).toBe("2023-04-25");
    expect(clean.get("PT-TEXT-MONTH")?.enrollmentDate).toBe("2023-06-20");

    const quarantined = new Map(
      result.quarantined.map((q) => [q.record["patient_id"], q.issues.map((i) => i.code)])
    );
    expect(quarantined.get("PT-AMBIGUOUS")).toContain("DATE_AMBIGUOUS");
    expect(quarantined.get("PT-INVALID")).toContain("DATE_INVALID");
    expect(quarantined.get("PT-FUTURE")).toContain("FUTURE_DATE");
  });

  it("never leaks PII into any part of the result, and redaction tokens appear instead", async () => {
    const result = await runPipelineFromFile("data/incoming_patient_data.csv", {
      asOf: FIXED_ASOF,
    });
    const serialized = JSON.stringify(result);

    for (const forbidden of ["4451892", "John Williams", "412-XX-8891", "sarah.johnson", "Michael Chen"]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(serialized).toContain("[REDACTED:PATIENT_NAME]");
    expect(serialized).toContain("[REDACTED:MRN]");
    expect(serialized).toContain("[REDACTED:SSN]");
    expect(serialized).toContain("[REDACTED:EMAIL]");
    expect(serialized).toContain("[REDACTED:STAFF_NAME]");
  });

  describe("duplicate resolution", () => {
    it("keeps the latest version and drops the older one when only follow-up data differs", () => {
      const result = runPipeline(
        csv([
          { patient_id: "PT-DUP", last_visit_date: "2023-06-01", response_assessment: "stable_disease" },
          { patient_id: "PT-DUP", last_visit_date: "2023-09-01", response_assessment: "partial_response" },
        ])
      );

      expect(result.clean).toHaveLength(1);
      expect(result.clean[0]?.lastVisitDate).toBe("2023-09-01");
      expect(result.dropped).toEqual([
        expect.objectContaining({ patientId: "PT-DUP", reason: "DUPLICATE_SUPERSEDED" }),
      ]);
    });

    it("quarantines every version when the same patient_id has conflicting baseline data", () => {
      const result = runPipeline(
        csv([
          { patient_id: "PT-CONFLICT", age: "40" },
          { patient_id: "PT-CONFLICT", age: "60" },
        ])
      );

      expect(result.clean).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
      expect(result.quarantined).toHaveLength(2);
      for (const q of result.quarantined) {
        expect(q.issues.map((i) => i.code)).toContain("DUPLICATE_CONFLICT");
      }
    });

    it("keeps one copy and drops the rest when rows are identical in every field", () => {
      const result = runPipeline(csv([{ patient_id: "PT-EXACT" }, { patient_id: "PT-EXACT" }]));

      expect(result.clean).toHaveLength(1);
      expect(result.dropped).toEqual([
        expect.objectContaining({ patientId: "PT-EXACT", reason: "DUPLICATE_EXACT" }),
      ]);
    });
  });

  describe("blank vs. zero", () => {
    it("quarantines a blank age as missing, not implausible", () => {
      const result = runPipeline(csv([{ patient_id: "PT-BLANK-AGE", age: "" }]));
      const issue = result.quarantined[0]!;
      const codes = issue.issues.map((i) => i.code);
      expect(codes).toContain("MISSING_REQUIRED_FIELD");
      expect(codes).not.toContain("AGE_IMPLAUSIBLE");
    });

    it("quarantines a weight of 0 as implausible, not missing", () => {
      const result = runPipeline(csv([{ patient_id: "PT-ZERO-WEIGHT", weight_kg: "0" }]));
      const issue = result.quarantined[0]!;
      const codes = issue.issues.map((i) => i.code);
      expect(codes).toContain("WEIGHT_IMPLAUSIBLE");
      expect(codes).not.toContain("MISSING_REQUIRED_FIELD");
    });
  });

  describe("encoding", () => {
    it("gives an identical result whether or not the input has a BOM and CRLF line endings", () => {
      const plain = csv([{ patient_id: "PT-ENC", lab_notes: "note with an em dash — here" }]);
      const withBomAndCrlf = "﻿" + plain.replace(/\n/g, "\r\n");

      const resultA = runPipeline(plain);
      const resultB = runPipeline(withBomAndCrlf);

      expect(resultB).toEqual(resultA);
    });

    it("quarantines a row containing a mojibake signature", () => {
      const result = runPipeline(
        csv([{ patient_id: "PT-MOJIBAKE", lab_notes: "cafÃ© result pending" }])
      );
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0]!.issues.map((i) => i.code)).toContain("ENCODING_ARTIFACT");
    });

    it("leaves valid em dashes unchanged", () => {
      const result = runPipeline(
        csv([{ patient_id: "PT-DASH", lab_notes: "stable — no change" }])
      );
      expect(result.clean[0]?.labNotes).toBe("stable — no change");
    });
  });

  it("is deterministic across repeated runs and does not mutate its input", async () => {
    const csvText = await readFile("data/incoming_patient_data.csv", "utf-8");
    const original = csvText.slice();

    const first = runPipeline(csvText, { asOf: FIXED_ASOF });
    const second = runPipeline(csvText, { asOf: FIXED_ASOF });

    expect(second).toEqual(first);
    expect(csvText).toBe(original);
  });

  describe("cross-registry checks", () => {
    it("quarantines an unknown trial_id", () => {
      const result = runPipeline(csv([{ patient_id: "PT-UNKNOWN", trial_id: "NCT-999" }]));
      expect(result.quarantined[0]!.issues.map((i) => i.code)).toContain("UNKNOWN_TRIAL");
    });

    it("quarantines enrollment before the trial's start date", () => {
      // NCT-001 starts 2023-03-15.
      const result = runPipeline(
        csv([{ patient_id: "PT-EARLY", trial_id: "NCT-001", enrollment_date: "2023-01-01" }])
      );
      expect(result.quarantined[0]!.issues.map((i) => i.code)).toContain(
        "ENROLLMENT_BEFORE_TRIAL_START"
      );
    });

    it("quarantines a last visit before enrollment", () => {
      const result = runPipeline(
        csv([
          {
            patient_id: "PT-BACKWARDS",
            enrollment_date: "2023-06-01",
            last_visit_date: "2023-05-01",
          },
        ])
      );
      expect(result.quarantined[0]!.issues.map((i) => i.code)).toContain(
        "VISIT_BEFORE_ENROLLMENT"
      );
    });
  });

  it("throws PipelineInputError when a required column is missing from the header", () => {
    const badCsv = "trial_id,site_id\nNCT-001,SITE-A01\n";
    expect(() => runPipeline(badCsv)).toThrow(PipelineInputError);
  });
});
