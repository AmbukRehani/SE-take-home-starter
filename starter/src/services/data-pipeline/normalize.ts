import type { Issue } from "../../types.js";

const MONTH_NAMES: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Rejects impossible dates like 2023-02-30 with a UTC round-trip check. */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export interface DateParseResult {
  iso: string | null;
  issue?: Issue;
}

/**
 * Parses a date field in any of the formats seen in the source file
 * (ISO, YYYY/MM/DD, slash M/D/Y or D/M/Y, "Mon DD YYYY") into an ISO
 * YYYY-MM-DD string. Never falls back to `new Date(string)`, since that
 * parser's behavior for non-ISO strings varies by JS engine.
 */
export function parseFlexibleDate(
  raw: string,
  field: string,
  slashDateOrder?: "MDY" | "DMY"
): DateParseResult {
  const value = raw.trim();
  if (value === "") {
    return {
      iso: null,
      issue: {
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `${field} is missing`,
      },
    };
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [, y, mo, d] = m as unknown as [string, string, string, string];
    if (!isValidCalendarDate(+y, +mo, +d)) {
      return {
        iso: null,
        issue: {
          code: "DATE_INVALID",
          field,
          message: `${field}="${value}" is not a valid calendar date`,
        },
      };
    }
    return { iso: value };
  }

  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (m) {
    const [, y, mo, d] = m as unknown as [string, string, string, string];
    if (!isValidCalendarDate(+y, +mo, +d)) {
      return {
        iso: null,
        issue: {
          code: "DATE_INVALID",
          field,
          message: `${field}="${value}" is not a valid calendar date`,
        },
      };
    }
    return {
      iso: `${y}-${pad(+mo)}-${pad(+d)}`,
      issue: {
        code: "DATE_NORMALIZED",
        field,
        message: `${field} normalized from "${value}"`,
      },
    };
  }

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (m) {
    const [, a, b, y] = m as unknown as [string, string, string, string];
    const first = +a;
    const second = +b;
    let month: number;
    let day: number;

    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else if (first > 12 && second > 12) {
      return {
        iso: null,
        issue: {
          code: "DATE_INVALID",
          field,
          message: `${field}="${value}" is not a valid date`,
        },
      };
    } else if (slashDateOrder === "DMY") {
      day = first;
      month = second;
    } else if (slashDateOrder === "MDY") {
      month = first;
      day = second;
    } else {
      return {
        iso: null,
        issue: {
          code: "DATE_AMBIGUOUS",
          field,
          message: `${field}="${value}" could be month-first or day-first; pass slashDateOrder to resolve`,
        },
      };
    }

    if (!isValidCalendarDate(+y, month, day)) {
      return {
        iso: null,
        issue: {
          code: "DATE_INVALID",
          field,
          message: `${field}="${value}" is not a valid calendar date`,
        },
      };
    }
    return {
      iso: `${y}-${pad(month)}-${pad(day)}`,
      issue: {
        code: "DATE_NORMALIZED",
        field,
        message: `${field} normalized from "${value}"`,
      },
    };
  }

  m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/.exec(value);
  if (m) {
    const [, monName, d, y] = m as unknown as [string, string, string, string];
    const month = MONTH_NAMES[monName.toLowerCase()];
    if (!month || !isValidCalendarDate(+y, +month, +d)) {
      return {
        iso: null,
        issue: {
          code: "DATE_INVALID",
          field,
          message: `${field}="${value}" is not a valid calendar date`,
        },
      };
    }
    return {
      iso: `${y}-${month}-${pad(+d)}`,
      issue: {
        code: "DATE_NORMALIZED",
        field,
        message: `${field} normalized from "${value}"`,
      },
    };
  }

  return {
    iso: null,
    issue: {
      code: "DATE_INVALID",
      field,
      message: `${field}="${value}" is not a recognized date format`,
    },
  };
}

export interface SexParseResult {
  value: "M" | "F" | "Other";
  issue?: Issue;
}

export function normalizeSex(raw: string, field = "sex"): SexParseResult {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "m") return { value: "M" };
  if (lower === "f") return { value: "F" };
  if (lower === "male") {
    return {
      value: "M",
      issue: {
        code: "SEX_NORMALIZED",
        field,
        message: `${field} normalized from "${raw}"`,
      },
    };
  }
  if (lower === "female") {
    return {
      value: "F",
      issue: {
        code: "SEX_NORMALIZED",
        field,
        message: `${field} normalized from "${raw}"`,
      },
    };
  }
  if (trimmed === "Other") return { value: "Other" };
  return {
    value: "Other",
    issue: {
      code: "SEX_NORMALIZED",
      field,
      message: `${field} normalized from "${raw}"`,
    },
  };
}

const KNOWN_RESPONSE_CATEGORIES = new Set([
  "complete_response",
  "partial_response",
  "stable_disease",
  "progressive_disease",
]);

export interface ResponseParseResult {
  value: string | null;
  issue?: Issue;
}

export function normalizeResponse(
  raw: string,
  field = "response_assessment"
): ResponseParseResult {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "N/A") {
    return {
      value: null,
      ...(trimmed !== "" && {
        issue: {
          code: "RESPONSE_NORMALIZED",
          field,
          message: `${field} normalized from "${raw}" to null`,
        },
      }),
    };
  }
  if (KNOWN_RESPONSE_CATEGORIES.has(trimmed)) {
    return { value: trimmed };
  }
  return {
    value: trimmed,
    issue: {
      code: "RESPONSE_UNKNOWN",
      field,
      message: `${field}="${raw}" is not a recognized RECIST category`,
    },
  };
}

export function normalizeAdverseEvents(raw: string): string[] {
  const parts = raw
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  return Array.from(new Set(parts));
}

export interface NumberParseResult {
  value: number | null;
  issue?: Issue;
}

/**
 * Blank checks run before numeric parsing: `Number("")` is 0 in
 * JavaScript, which would otherwise turn a missing age into "age 0" and
 * report it as implausible instead of missing.
 */
export function parseRequiredNumber(raw: string, field: string): NumberParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      value: null,
      issue: {
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `${field} is missing`,
      },
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return {
      value: null,
      issue: {
        code: "MISSING_REQUIRED_FIELD",
        field,
        message: `${field}="${raw}" is not a number`,
      },
    };
  }
  return { value: n };
}
