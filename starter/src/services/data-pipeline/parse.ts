import { parse } from "csv-parse/sync";
import type { Issue } from "../../types.js";

export class PipelineInputError extends Error {}

export interface RawRow {
  sourceLine: number;
  fields: Record<string, string>;
  issues: Issue[];
}

const REQUIRED_COLUMNS = [
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

// Zero-width characters and the U+FEFF BOM/zero-width-no-break-space.
const ZERO_WIDTH_AND_BOM = /[​‌‍﻿]/g;

/**
 * Strips a BOM, normalizes line endings and Unicode form, and removes
 * invisible characters that don't affect what a human sees but can break
 * exact-match comparisons downstream. Deliberately does not attempt to
 * re-decode mis-encoded bytes (e.g. latin-1 misread as UTF-8): that repair
 * can silently corrupt otherwise-valid text, so a suspected mojibake row is
 * quarantined instead (see `detectMojibake`).
 */
export function decodeText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/ /g, " ")
    .replace(ZERO_WIDTH_AND_BOM, "");
}

const MOJIBAKE_PATTERNS = [
  /Ã[-¿]/,
  /â€/,
  /�/,
];

/** Signatures of UTF-8 bytes that were decoded as Latin-1 (or vice versa). */
export function detectMojibake(text: string): boolean {
  return MOJIBAKE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Parses decoded CSV text into per-row field maps. A missing required
 * column is a file-level problem (throws PipelineInputError); a row with
 * the wrong number of columns is a row-level problem (quarantined as
 * MALFORMED_ROW, not thrown).
 */
export function parseRows(csvText: string): RawRow[] {
  const decoded = decodeText(csvText);

  const records: string[][] = [];
  const lineNumbers: number[] = [];
  parse(decoded, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    on_record: (record: string[], context: { lines: number }) => {
      records.push(record);
      lineNumbers.push(context.lines);
      return record;
    },
  });

  if (records.length === 0) {
    throw new PipelineInputError("CSV file has no header row");
  }

  const header = records[0]!;
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new PipelineInputError(`Missing required column: ${column}`);
    }
  }

  const rows: RawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i]!;
    const sourceLine = lineNumbers[i]!;

    if (record.length !== header.length) {
      rows.push({
        sourceLine,
        fields: {},
        issues: [
          {
            code: "MALFORMED_ROW",
            message: `expected ${header.length} columns, got ${record.length}`,
          },
        ],
      });
      continue;
    }

    const fields: Record<string, string> = {};
    header.forEach((column, index) => {
      fields[column] = (record[index] ?? "").trim();
    });

    const issues: Issue[] = [];
    if (Object.values(fields).some((value) => detectMojibake(value))) {
      issues.push({
        code: "ENCODING_ARTIFACT",
        message: "row contains a mojibake signature (misdecoded text)",
      });
    }

    rows.push({ sourceLine, fields, issues });
  }

  return rows;
}
