# Data Pipeline Decisions

## Principles

Four rules drive every judgment call below:

1. **Never guess a clinical value.** An age of 155 could be a typo for 55
   or 15 — the pipeline can't know which, so a human decides. Imputation
   (substituting the median age, etc.) is rejected outright because it
   silently shifts safety analyses without anyone noticing it happened.
2. **Blank is not zero.** `Number("")` is `0` in JavaScript, so a blank age
   field would otherwise become "age 0" and get reported as implausible
   instead of missing. Blank checks run before any numeric parsing, for
   every numeric field.
3. **Quarantine is the default for doubt; drop is reserved for exact or
   superseded duplicates.** The pipeline never drops a row whose
   information isn't preserved somewhere else — a row with a real problem
   goes to quarantine so a human can look at it, and only a literal
   duplicate (or an older version fully superseded by a newer one) is
   actually discarded.
4. **Redact before anything leaves the pipeline, patient PII is worse than
   staff PII.** A patient's name, MRN, or SSN in a CRO file is a privacy
   incident someone has to report, so those rows are quarantined, not just
   cleaned up. A staff member's name in a lab note is not patient PHI, so
   it's redacted and the row stays clean. Quarantine output itself is
   redacted too — storing the raw PII in a second place (the quarantine
   bucket) would just copy the leak, not contain it.

## What the file actually contains

`data/incoming_patient_data.csv` has **51 data rows, not the 50** the
README states — verified by counting lines (52 total, minus the header).
The extra row is `PT-003` appearing twice: an original visit and a later
one with an "UPDATE" note and a corrected (but unrecognized) response
category.

The file's only non-ASCII characters are 12 valid em dashes (U+2014, e.g.
"declining — consider dose adjustment"). There's no BOM, no CRLF line
endings, and no mojibake — I checked with `xxd` and a grep for the
replacement character and CRLF bytes before writing the encoding tests.
**This file has no real encoding artifacts.** The pipeline still defends
against BOMs, CRLF, and mojibake signatures (tested with synthetic
fixtures in `data-pipeline.test.ts`), because a future file from the same
CRO partner might not be this clean, but I'm not going to invent a problem
in this file just to match the README.

## Decisions by category

### Mixed date formats
- Found: `PT-003` (`04/25/2023`), `PT-009` (`Jun 20 2023`), `PT-019`
  (`2023/11/01`), `PT-028` (`15/05/2024`) — plus both PT-003 rows' and
  PT-009's `last_visit_date` in the same non-ISO formats.
- Decision: normalize to ISO `YYYY-MM-DD`; count it as `DATE_NORMALIZED`.
- Why: every one of these is unambiguous once you look at the actual
  values — `15/05/2024` can only be day-first since 15 isn't a valid
  month, `2023/11/01` can only be year-first since 2023 isn't a valid day
  or month, and the others are either already ISO or use an unambiguous
  slash order. None of them require guessing.
- Alternatives considered: parsing with `new Date(string)` directly. I
  rejected this because its behavior for non-ISO strings is
  engine-defined, not spec-defined — the same string can parse
  differently across Node versions or browsers. `parseFlexibleDate` uses
  explicit regexes per format instead.

### Ambiguous slash dates (both parts ≤ 12)
- Found: none in this file.
- Decision: quarantine (`DATE_AMBIGUOUS`); never guess. Exercised only
  with a synthetic fixture (`03/04/2024`) in the test suite.
- Why: `03/04/2024` is genuinely either March 4th or April 3rd, and
  guessing wrong in either direction silently corrupts a visit date. The
  pipeline accepts an explicit `slashDateOrder: "MDY" | "DMY"` option so a
  caller who *does* know the source convention for a given file can
  resolve it — but the default is to quarantine, not assume.

### Missing patient ID
- Found: one row (source line 31 — an `NCT-003` screen-fail visit).
- Decision: quarantine (`MISSING_REQUIRED_FIELD`).
- Why: `patient_id` is the join key for everything downstream (duplicate
  resolution, cross-referencing, any future re-identification for
  follow-up). A row with no ID can't be deduplicated or safely merged with
  anything, so it can't be trusted as clean data.

### Missing age
- Found: `PT-011`.
- Decision: quarantine (`MISSING_REQUIRED_FIELD`), never `AGE_IMPLAUSIBLE`.
- Why: this is principle #2. `parseRequiredNumber` checks for an empty
  string *before* calling `Number()` on it, specifically so a blank field
  is reported as missing, not as a (false) implausible value of zero.

### Implausible age
- Found: `PT-004` (age `-3`), `PT-016` (age `155`).
- Decision: quarantine (`AGE_IMPLAUSIBLE`); do not guess `15` or `55` for
  the transposed-looking `155`.
- Why: principle #1. A negative age is obviously a data-entry error, and
  `155` is almost certainly `15` or `55` with an extra digit — but "almost
  certainly" isn't good enough for a clinical field.

### Implausible weight
- Found: `PT-014` (`0` kg).
- Decision: quarantine (`WEIGHT_IMPLAUSIBLE`).
- Why: `0` here is not a real weight, it's "missing" wearing a numeric
  disguise — but unlike the age case, `weight_kg` was actually filled in
  with the literal text `0`, so `parseRequiredNumber` correctly returns
  the number `0` (not "missing"), and the plausibility range check
  (`< 30`) is what catches it. This is a deliberate contrast with the
  blank-age case: two different-looking problems that both mean "we don't
  have a real value," caught by two different mechanisms.

### Non-standard sex
- Found: `PT-040` (`Male`).
- Decision: normalize to `M`; count it as `SEX_NORMALIZED`.
- Why: single-letter `M`/`F` values need no change; `Male`/`Female` are
  unambiguous synonyms.

### Response `N/A`
- Found: `PT-006`, `PT-025`, line 31, `PT-037`.
- Decision: map to `null`; count it as `RESPONSE_NORMALIZED`.
- Why: `null` is the honest representation of "not assessed" — it's
  distinct from a genuine RECIST category and from the "unknown value"
  case below, and every consumer of `PatientRecord.responseAssessment`
  can check for `null` explicitly instead of string-matching `"N/A"`.

### Unknown response value
- Found: `PT-003`'s second (newer) row (`confirmed_response`).
- Decision: quarantine (`RESPONSE_UNKNOWN`); not a RECIST category.
- Why: the four categories that actually appear elsewhere in this file
  (`complete_response`, `partial_response`, `stable_disease`,
  `progressive_disease`) are the full known set. `confirmed_response`
  isn't one of them, and inventing a mapping for it (e.g. assuming it
  means `partial_response`, since the row's own note says "confirmed
  PR") is exactly the kind of clinical guess principle #1 forbids — a
  human should confirm what "confirmed" was actually meant to convey.

### Patient identifiers in notes
- Found: `PT-004` (a patient name + MRN in the same sentence), `PT-037`
  (a partial SSN).
- Decision: redact **and** quarantine (`PII_PATIENT`).
- Why: principle #4. This is a privacy incident, not just a formatting
  problem — a human needs to see that it happened and confirm nothing else
  leaked, since regex redaction is best-effort by nature.

### Staff identifiers in notes
- Found: `PT-004` and `PT-021` (a "Dr. \<Name\>" mention), `PT-017` (a
  staff email address), `PT-050` (a "CRA \<Name\>" mention).
- Decision: redact; keep in clean with a warning (`PII_STAFF`).
- Why: a staff member's name or work email is not patient PHI. It's still
  worth redacting (there's no reason to keep it in a dataset meant for
  analytics) and worth flagging so a reviewer can see why the text
  changed, but it doesn't rise to the level of a privacy incident the way
  patient PII does.

### Duplicate with newer data
- Found: `PT-003` — two rows with identical baseline fields (`trial_id`,
  `site_id`, `enrollment_date`, `age`, `sex`), but the second has a later
  `last_visit_date` and an updated (though unrecognized) response.
- Decision: keep the latest version (by `last_visit_date`); drop the older
  one (`DUPLICATE_SUPERSEDED`).
- Why: deduplication runs *before* validation, deliberately. The kept
  (newer) row is what then gets checked for a valid response category, and
  it fails that check (`RESPONSE_UNKNOWN`) and ends up quarantined anyway.
  The pipeline does not fall back to the older row when the newer one
  turns out to have a problem — the older row is known-stale data, and
  silently resurrecting it would hide the fact that this patient's most
  recent status needs a human's attention.
- Alternatives considered: comparing every field for equality and only
  treating exact matches as duplicates, falling back to "keep both" for
  anything else. Doc's own inventory (and rule 6, generalized below) is
  clearer: same baseline + different follow-up is a legitimate update,
  not an ambiguous case.

### Status contradicts trial
- Found: `PT-045` — `status: active` in `NCT-002`, which is `completed`.
- Decision: quarantine (`STATUS_TRIAL_MISMATCH`).
- Why: a trial that's finished enrolling and reporting shouldn't have
  patients whose record still says they're active — that's either stale
  data entry or a data-integration bug, either way worth a human looking
  at it rather than accepting it at face value.

### Sex inconsistent with indication
- Found: `PT-006` — sex `F` in `NCT-001`, a prostate cancer trial (status
  already `screen_fail`).
- Decision: keep with a warning (`SEX_INDICATION_MISMATCH`), not
  quarantine.
- Why: the row's own `status` field already records that something went
  wrong at screening (the lab note literally asks "female patient enrolled
  in error?"), so quarantining on top of that would just be redundant.
  `sexRestrictedIndications` defaults to any indication containing
  "prostate" (case-insensitive substring match against `ClinicalTrial.indication`)
  and is configurable via `PipelineOptions`, since a different trial
  roster might restrict on different indications.

### Blank adverse events / blank lab notes
- Found: `PT-003`, `PT-010`, `PT-024` (blank `adverse_events`); `PT-048`
  (blank `lab_notes`).
- Decision: accept as `[]` / `""`, no issue.
- Why: a blank adverse-events field genuinely means "none reported" for
  this kind of form, and a blank lab note means there was nothing to add
  at that visit — treating either as an error would be inventing a
  problem where the data is simply, validly, empty.

### Encoding
- Found: 12 em dashes (U+2014); no BOM, no CRLF, no mojibake — see "What
  the file actually contains" above.
- Decision: keep the em dashes unchanged; build the defenses (BOM
  stripping, CRLF normalization, mojibake detection) anyway, since a
  future file from the same source might need them.

## Assumptions about the downstream consumer

- The consumer runs analytics on safety and efficacy signals across
  trials, so a wrong number silently propagating (a implausible age
  treated as real, an unrecognized response category silently dropped
  from a summary) is worse than a row sitting in quarantine for a day.
- The trial population is adult oncology patients — hence the 18–100 age
  and 30–250kg weight plausibility defaults, both overridable via
  `PipelineOptions.ranges` since they're policy, not physics.
- Screen-fail patients are legitimate rows to keep (with a warning where
  relevant), not something to filter out — a screen failure is itself a
  meaningful outcome for a downstream consumer to be able to query.
- A human reviewer works the quarantine queue; the pipeline's job is to
  surface a clear, specific reason (`Issue.code` + `message`) for each row,
  not to resolve every ambiguity itself.

## Result on the provided file

With `asOf = 2026-09-24`:

| Bucket | Count | Patients |
|---|---|---|
| Clean | 42 | Everyone not listed below; warnings on PT-006, PT-017, PT-021, PT-050 |
| Quarantined | 8 | PT-003 (latest, `RESPONSE_UNKNOWN`), PT-004 (`AGE_IMPLAUSIBLE` + `PII_PATIENT` + `PII_STAFF`), PT-011 (`MISSING_REQUIRED_FIELD`), PT-014 (`WEIGHT_IMPLAUSIBLE`), PT-016 (`AGE_IMPLAUSIBLE`), PT-037 (`PII_PATIENT`), PT-045 (`STATUS_TRIAL_MISMATCH`), line 31 (`MISSING_REQUIRED_FIELD`) |
| Dropped | 1 | PT-003 (older version, `DUPLICATE_SUPERSEDED`) |

`totalInput (51) === totalClean (42) + totalQuarantined (8) + totalDropped (1)`
holds and is asserted inside `runPipeline` — it throws if it ever doesn't.

This matches the design doc's expected table exactly; I didn't need to
adjust any expected value.

## Known limitations

- **Regex PII detection is a floor, not a ceiling.** It catches the
  explicit patterns seen in this file (a name after "Patient", an MRN
  prefix, an SSN-shaped number, an email, "Dr./CRA + name"), but free text
  can leak identifying information in forms no fixed pattern set will
  ever fully cover. Production should use a dedicated PHI
  de-identification service, not hand-written regexes.
- **Plausibility ranges are configurable defaults, not clinical truth.**
  18–100 / 30–250kg are reasonable for adult oncology but were not derived
  from any specific trial's actual eligibility criteria — a trial with a
  narrower or wider real eligibility window would need its own ranges
  passed via `PipelineOptions.ranges`.
- **`DUPLICATE_CONFLICT`, `MALFORMED_ROW`, and the full registry
  cross-check set are exercised only by synthetic test fixtures**, not by
  this file, since none of those situations actually occur in it. That's
  a property of the data, not a gap in the pipeline — the tests were
  written to prove the code handles them anyway, since a future CRO file
  isn't guaranteed to be this well-behaved.
