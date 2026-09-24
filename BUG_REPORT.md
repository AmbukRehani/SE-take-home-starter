# Bug Report

## How I hunted

I ran the suite on a clean install first: 7 of 8 tests passed and 1 failed
("sorts by startDate"), and `tsc --noEmit` reported 3 errors, contrary to
what the README claims. From there I read each file end to end against its
own types rather than trusting the design doc's line numbers blindly, and
for every claim I re-derived the bug from the code itself — for B1 by
working through the comparator by hand, for B3 by writing a throwaway
script against `MockLanguageModelV1` to see what `fullStream` actually does
on a provider error, and for B5/B6 by tracing what `listTrials` does to the
same objects `getTrialById` serves. Every fix has a test that fails on the
pre-fix code and passes after, committed in that order.

## Summary

| # | Bug | File:line | Category | Severity | Fix commit |
|---|-----|-----------|----------|----------|------------|
| B1 | Default date sort is reversed | `trial-service.ts:74-78` | Data integrity | High | `56bf39c` |
| B2 | `/summary` crashes for trials with null response rate | `analysis-service.ts:94` | Type-safety hole | High | `a2ad019` |
| B3 | AI stream errors return 200 + empty body; upstream never aborted | `analysis-service.ts:41-79`, `routes/trials.ts:97-118` | Reliability / cost | High | `6837648` |
| B4 | `focus` is not validated before a paid LLM call | `routes/trials.ts:71-95` | Security / type-safety | High | `4b6631c` |
| B5 | Search mutates shared trial objects (`_score`) | `trial-service.ts:52-63`, `data.ts:158-161` | Shared state / race | Medium | `aac7c1f` |
| B6 | Search never matches key findings | `trial-service.ts:60` | Logic | Medium | `7d45dc9` |
| B7 | Risk score rises with better efficacy | `analysis-service.ts:119` | Data integrity | Medium | `b155bd7` |
| B8 | Query params are cast, not validated | `routes/trials.ts:13-21`, `trial-service.ts:42` | Type-safety / input | Medium | `e3c0811` |
| B9 | Build is broken: `@types/express` 5 vs Express 4 | `package.json` | Tooling / types | Low | `aba2520`, `e3c0811` |

## B1 - Default date sort is reversed

**How I found it.** The pre-existing "sorts by startDate" test was already
failing on a clean install. I traced the `startDate` comparator by hand:
it computed `new Date(b.startDate).getTime() - new Date(a.startDate).getTime()`
(descending), and then the direction switch at the bottom of `listTrials`
negated it again for the default `order="desc"`. Two negations cancel out,
so the default list came back oldest-first, and `order=asc` came back
newest-first — the opposite of what every other sortable field does
(`enrollment` and `adverseEventRate` both compute ascending and let the
switch alone decide direction).

**Impact in production.** The default `/trials` view — the one every client
sees with no query params — showed the oldest trials first instead of the
newest. Any client that explicitly asked for `order=asc` got the reverse of
what it asked for.

**Fix.** `trial-service.ts:77`
```diff
-        cmp =
-          new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
+        cmp =
+          new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
```

**Why it is correct.** Every case in the switch now computes ascending, and
the single `sortOrder === "asc" ? cmp : -cmp` at the bottom is the only
place direction is decided — restoring the invariant the other two fields
already followed.

**Alternatives considered.** I could have instead removed the outer negation
and left the comparator descending, but that would make `startDate` the odd
one out among the three sortable fields, which is a real invariant worth
keeping consistent for the next person who adds a sort field.

**Regression test.** `sorts by startDate ascending when order=asc is
requested` (`trials.test.ts`) — fails on the old code because
`order: "asc"` returned newest-first instead of oldest-first. The
pre-existing `sorts by startDate` test also now passes.

## B2 - `/summary` crashes on null response rate

**How I found it.** `getTrialSummary` builds its summary string with
`trial.responseRate!.toFixed(1)`, a non-null assertion on a field typed
`number | null` in `types.ts`. Calling it directly with NCT-003 (which has
`responseRate: null`) throws `TypeError: Cannot read properties of null
(reading 'toFixed')`. Through the route, Express 4's default error handler
turns that into a 500 with an HTML stack trace, because `NODE_ENV` isn't
`production`.

**Impact in production.** Every Phase I trial without efficacy data
(NCT-003 today, and by the design doc's own count, many more once the
dataset grows past ~500 trials) breaks the summary endpoint outright. The
default Express error page also leaks internal file paths in the stack
trace.

**Fix.** `analysis-service.ts:94`
```diff
-    `Current response rate: ${trial.responseRate!.toFixed(1)}%.`,
+    `Current response rate: ${trial.responseRate !== null ? `${trial.responseRate.toFixed(1)}%` : "not yet available"}.`,
```

**Why it is correct.** It matches the wording `buildPrompt` already uses
for the same null case, and it never crashes because it checks for null
before calling `.toFixed`.

**Alternatives considered.** Falling back to `?? 0` was tempting since it's
a one-character fix, but a fabricated 0% response rate would be reported to
an analyst as a real number — worse than a visible crash in a pharma
product, where a wrong number can silently steer a decision.

**Regression test.** `getTrialSummary > does not throw for a trial with a
null response rate` (`analysis-service.test.ts`) asserts no throw and that
the summary contains "not yet available" and not "0.0%". `GET
/trials/:id/summary > returns 200 JSON for a trial with a null response
rate` (`routes.test.ts`) covers the same case through the actual route.

## B3 - Stream errors are invisible, and disconnects keep spending tokens

**How I found it.** I wrote a throwaway script against
`MockLanguageModelV1` from `ai/test` with a `doStream` that throws, and
confirmed empirically that AI SDK v4's `fullStream` yields a single
`{ type: "error", error }` part and then finishes normally — it does not
throw or reject. The old code iterated `result.textStream`, which silently
drops that part, so after `response.writeHead(200, …)` has already run, the
client gets a `200`, zero chunks, then `data: [DONE]`. Separately, there was
no `AbortSignal` anywhere: closing the browser tab mid-analysis did not
stop the upstream OpenAI call, so generation ran to completion and was
billed regardless.

**Impact in production.** A 429, an expired key, or an outage all look
identical to a successful, empty analysis — nothing alerts, and no one
notices until an analyst asks why the box is blank. Every abandoned
request (a closed tab, a page navigation) burns paid tokens for a response
nobody reads, which matters directly against the $200/month budget cap
discussed in the ADR.

**Fix.** `analysis-service.ts:41-79`, `routes/trials.ts:97-118`
```diff
 export async function streamAnalysis(
   trial: ClinicalTrial,
   focus: AnalysisFocus,
   response: { ... },
+  abortSignal?: AbortSignal
 ): Promise<void> {
   ...
-  const result = streamText({ model: openai("gpt-4o-mini"), prompt });
-  for await (const chunk of result.textStream) {
-    response.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
-  }
-  response.write("data: [DONE]\n\n");
-  response.end();
+  const result = streamText({
+    model: openai("gpt-4o-mini"),
+    prompt,
+    ...(abortSignal !== undefined && { abortSignal }),
+  });
+  try {
+    for await (const part of result.fullStream) {
+      if (part.type === "text-delta") {
+        response.write(`data: ${JSON.stringify({ text: part.textDelta })}\n\n`);
+      } else if (part.type === "error") {
+        console.error("Analysis stream error:", part.error);
+        response.write(`event: error\ndata: ${JSON.stringify({ error: "Analysis failed" })}\n\n`);
+        return;
+      }
+    }
+    response.write("data: [DONE]\n\n");
+  } finally {
+    response.end();
+  }
 }
```
Route side: an `AbortController` is created per request and `abort()`d from
`res.on("close")` when `!res.writableFinished`, and its signal is forwarded
into `streamAnalysis`.

**Why it is correct.** Iterating `fullStream` instead of `textStream` makes
the `error` part observable, so it can be surfaced as an in-band SSE
`event: error` instead of silently vanishing; the `try/finally` guarantees
`response.end()` runs on every path, including the error one. Using
`res.on("close")` rather than `req.on("close")` matters specifically on
Node 22: `req` emits `close` as soon as the request body is fully read,
which for a small JSON POST body happens almost immediately — using it
would abort every request right after it starts, not just abandoned ones.
`res` only closes when the response itself is torn down.

**Alternatives considered.** Checking the provider before writing headers
(so real errors could return an actual 5xx) would work for the "always
fails immediately" case, but it delays time-to-first-byte for the common
success path and still can't catch a failure that happens mid-stream after
the first token — an in-band SSE error event is the standard approach once
streaming has already started, and it's the only approach that covers both
cases uniformly.

**Regression test.** Two tests in `routes.test.ts`, both against a real
Express app with `@ai-sdk/openai` mocked via `vi.mock` +
`MockLanguageModelV1`: `emits an SSE error event and never sends [DONE]
when the model errors` (fails on the old code because the body was
`data: [DONE]\n\n` with no `event: error`), and `aborts the upstream call
when the client disconnects`, which reads one real chunk from the response
stream, aborts the client `fetch`, and asserts the mock's `doStream`
received an `abortSignal` whose `.aborted` becomes `true` — this fails on
the old code because no signal was ever forwarded.

## B4 - `focus` is not validated

**How I found it.** The route read `req.body.focus` and passed it straight
through as `focus as any`. `focusInstructions` is a plain object keyed by
the three valid focus values; looking it up with anything else returns
`undefined`, which gets interpolated into the prompt as the literal text
`"undefined"`. Because the lookup is a plain property access, I checked
whether it walks the prototype chain — it does, so `focus: "constructor"`
resolves to `Object`'s constructor function and gets stringified
(`function Object() { [native code] }`) into the prompt.

**Impact in production.** Any malformed request — a missing field, a typo,
or a deliberately crafted value — still passed through to a paid OpenAI
call and returned a 200 with a meaningless analysis. There was no error
path a client bug could hit that would actually surface as an error; it
would just quietly burn budget and return junk.

**Fix.** `routes/trials.ts:71-95`
```diff
+const analyzeBodySchema = z.object({
+  focus: z.enum(["safety", "efficacy", "competitive"]),
+});
+
 router.post("/:id/analyze", async (
-  req: Request<{ id: string }, unknown, { focus: string }>,
+  req: Request<{ id: string }, unknown, unknown>,
   res: Response<ErrorResponse>
 ) => {
   ...
-  const { focus } = req.body;
+  const parsed = analyzeBodySchema.safeParse(req.body);
+  if (!parsed.success) {
+    res.status(400).json({ error: ... });
+    return;
+  }
   try {
-    await streamAnalysis(trial, focus as any, res);
+    await streamAnalysis(trial, parsed.data.focus, res);
```

**Why it is correct.** The body is now typed `unknown` until it passes
through the zod schema, so there is no `as any` left to hide a type error,
and every invalid request is rejected with 400 before the model is ever
touched — the schema is the single source of truth for what a valid focus
value is, matching `AnalysisFocus` in `types.ts`.

**Alternatives considered.** None seriously — this is a straightforward
validate-before-you-spend-money case with no real tradeoff.

**Regression test.** `POST /trials/:id/analyze focus validation` in
`routes.test.ts`, parameterized over `{}`, `{ focus: "bogus" }`, and
`{ focus: "constructor" }`: each asserts a 400 status and that the mocked
model's `doStream` was never called. All three currently pass 200 with the
old code and the mock is invoked.

## B5 - Search writes `_score` onto shared trial objects

**How I found it.** `listTrials` does `let results = [...trialData]`,
which copies the array but not the objects inside it. The search branch
then does `(t as any)._score = score`, mutating the very same
`ClinicalTrial` objects that `trialCache` (built once at module load) hands
back from `getTrialById`. I confirmed by calling `listTrials({ search:
"prostate" })` and then `getTrialById("NCT-001")` in the same process:
the returned trial had a `_score` key that wasn't part of `ClinicalTrial`
at all, and its value was whatever the last search computed — not
NCT-001's own relevance to that search.

**Impact in production.** Internal scoring state leaked into the public API
contract on every trial, and one request's search could change what an
unrelated `GET /trials/:id` request returns next. `listTrials` is
synchronous today, so two requests can't literally interleave inside it,
but the design doc's own Part 3 plan moves this data behind a database —
the moment there's an `await` between scoring and serializing, this becomes
a genuine race condition between concurrent requests, not just a data leak.

**Fix.** `trial-service.ts:52-63`, `data.ts:158-161`
```diff
   if (filters.search) {
     const query = filters.search.toLowerCase();
+    const scores = new Map<string, number>();
     results = results.filter((t) => {
       let score = 0;
       ...
-      (t as any)._score = score;
+      scores.set(t.id, score);
       return score > 0;
     });
   }
```
and in `data.ts`, after the trial array literal:
```diff
+export const trials: ClinicalTrial[] = rawTrials.map((trial) => {
+  Object.freeze(trial.keyFindings);
+  return Object.freeze(trial);
+});
```

**Why it is correct.** The score is now kept in a `Map` local to the single
`listTrials` call and discarded when the function returns — nothing is
ever written onto a trial object. As defense in depth, every trial object
(and its `keyFindings` array) is frozen once at module load; ES modules run
in strict mode, so any future accidental write throws a `TypeError` instead
of silently corrupting shared state the way this bug did.

**Alternatives considered.** Returning `structuredClone` copies from every
service call also fixes the visible symptom, but it costs an allocation on
every request and doesn't stop the next person from reintroducing the same
mutation bug elsewhere — freezing does. I noticed the score is computed but
never used to rank results, which is clearly what the original author
intended; I left that as a follow-up rather than folding a ranking feature
into a bug fix.

**Regression test.** `does not leak internal search scores onto shared
trial objects` and `does not allow mutating a cached trial object`
(`trials.test.ts`) — the first fails on the old code because `_score`
appears both as an own property and in `JSON.stringify` output; the second
fails because mutating a cached trial silently succeeds instead of
throwing.

## B6 - Search never matches key findings

**How I found it.** `t.keyFindings.includes(query)` is
`Array.prototype.includes`, which checks for an array element exactly
equal to `query` — not a substring match. Since `query` is always
lowercased first, this can basically never match a `keyFindings` entry,
which are full sentences with mixed case. I confirmed with
`listTrials({ search: "photosensitivity" })`, which returned zero trials
even though BEACON-3's key findings mention "Photosensitivity in 41% of
patients" verbatim.

**Impact in production.** Key findings are the single most
information-dense field on a trial. Searching for an adverse event,
biomarker, or any term that only appears there silently returns zero
results — no error, just an empty list that looks like "there's nothing
matching," which is the worst kind of search bug because nobody notices.

**Fix.** `trial-service.ts:60`
```diff
-      if (t.keyFindings.includes(query)) score += 2;
+      if (t.keyFindings.some((f) => f.toLowerCase().includes(query)))
+        score += 2;
```

**Why it is correct.** `Array.prototype.some` with a per-finding
case-insensitive substring check matches the same intent every other field
in this function already uses (`t.name.toLowerCase().includes(query)`,
etc.) — `keyFindings` was the one field that never got the same treatment.

**Alternatives considered.** None — this is a one-line logic fix with no
real tradeoff.

**Regression test.** `matches search terms found only in key findings`
(`trials.test.ts`): `listTrials({ search: "photosensitivity" })` and the
uppercase variant both must include NCT-002. Fails on the old code with an
empty result.

## B7 - Risk score rises with better efficacy

**How I found it.** `calculateRiskScore` adds `+2` when
`trial.responseRate > 30`. Every other line in the function raises risk for
a *worse* signal (higher AE rate, terminated status, Phase I uncertainty),
so I checked the real data: BEACON-3 (61.3% response rate, a genuinely
effective combination therapy) scores higher risk than RADIANT-4 (2.0%
response rate) purely because of this one line.

**Impact in production.** The `/summary` endpoint's `riskScore` is exactly
the kind of number a triage dashboard would sort by. As written, it ranks
the most effective therapies as the riskiest, which would point an analyst
in the wrong direction every time.

**Fix.** `analysis-service.ts:119`
```diff
-  if (trial.responseRate !== null && trial.responseRate > 30) {
+  // Lower response rate = higher risk; a null response rate (Phase I,
+  // not yet available) is left neutral since phase uncertainty is
+  // already scored above.
+  if (trial.responseRate !== null && trial.responseRate < 30) {
     score += 2;
   }
```

**Why it is correct.** Flipping the comparison makes this line consistent
with every other factor in the function: a worse signal (low response)
raises risk, a null response rate (no data yet) stays neutral because
Phase I uncertainty is already captured by the phase check two lines
above, so null wouldn't be double-counted either way.

**Alternatives considered.** Response rate is genuinely a weak signal for
trials with survival endpoints — RADIANT-4 has a 2% response rate but a
strongly positive PFS result (HR 0.48), so even this corrected rule
overstates its risk. The principled fix is endpoint-aware scoring (weight
response rate differently depending on whether the primary endpoint is
response-based or survival-based), which is a real feature, not a minimal
bug fix, so I left it as a named limitation rather than in scope here.

**Regression test.** `scores a low response rate as riskier than a high
response rate` (synthetic fixtures, 60% vs 10%) and `scores RADIANT-4 (2%
response) riskier than BEACON-3 (61.3% response)` using the real trial data
(`analysis-service.test.ts`). Both fail on the old code with the ordering
reversed.

## B8 - Query params are cast, not validated

**How I found it.** `req.query` values come from Express's `qs` parser,
which can hand back a string, a string array (`?phase=I&phase=II`), or a
nested object (`?search[a]=b`) depending on how the query string is
shaped — but the route cast every value with `as string | undefined`
regardless. I checked each case by hand: `?search[a]=b` makes `search` an
object, so `.toLowerCase()` inside `trial-service.ts` throws and the route
returns an unhandled 500; `?phase=I&phase=II` makes `phase` an array, which
never strictly equals a string, so the filter matches nothing and the API
silently returns 0 trials; `?minEnrollment=abc` becomes `Number("abc") ===
NaN`, which is falsy, so the old `if (filters.minEnrollment)` check skipped
the filter entirely and returned *more* data than was asked for.

**Impact in production.** Malformed input produced wrong answers with a
200 status instead of a clear error in every case except the object one
(which crashed). The `minEnrollment=abc` case is the worst: a caller
filtering for large trials and typo'ing the value would silently get every
trial in the system back, with no indication anything was wrong.

**Fix.** `routes/trials.ts:13-45`
```diff
+const listQuerySchema = z.object({
+  phase: z.enum(["I", "II", "III"]).optional(),
+  status: z.enum(["recruiting", "completed", "terminated"]).optional(),
+  minEnrollment: z.coerce.number().int().nonnegative().optional(),
+  sponsor: z.string().trim().min(1).max(200).optional(),
+  search: z.string().trim().min(1).max(200).optional(),
+  sort: z.enum(["startDate", "enrollment", "adverseEventRate"]).optional(),
+  order: z.enum(["asc", "desc"]).optional(),
+});
+
 router.get("/", (req, res) => {
-  const { phase, status, minEnrollment, sponsor, search, sort, order } = req.query;
-  const result = listTrials({ phase: phase as string | undefined, ... });
+  const parsed = listQuerySchema.safeParse(req.query);
+  if (!parsed.success) {
+    res.status(400).json({ error: ... });
+    return;
+  }
+  const q = parsed.data;
+  const result = listTrials({
+    ...(q.phase !== undefined && { phase: q.phase }),
+    ...(q.minEnrollment !== undefined && { minEnrollment: q.minEnrollment }),
+    // ...same conditional-spread pattern for every field
+  });
```
and in `trial-service.ts:42`:
```diff
-  if (filters.minEnrollment) {
+  if (filters.minEnrollment !== undefined) {
```

**Why it is correct.** Every query param is now validated against an
explicit shape before it reaches `listTrials`; anything that doesn't fit —
an object, an array, a non-numeric string, an unknown enum value — is
rejected with 400 and a machine-readable reason instead of silently
producing a wrong or crashing response. Building the `filters` object with
conditional spreads (`...(q.x !== undefined && { x: q.x })`) instead of
always assigning each key means a key is either present with a real value
or entirely absent, never present-but-`undefined` — which is what
`exactOptionalPropertyTypes` in this tsconfig actually requires, and is
also what fixed the last remaining `tsc` error from B9 (see below).
Checking `!== undefined` instead of truthiness in `trial-service.ts` means
`minEnrollment=0` is treated as a real filter (keep trials with enrollment
≥ 0, i.e. all of them) instead of being silently skipped like a falsy
"no filter" sentinel — the visible behavior for this dataset happens to be
the same either way, but the check is now correct instead of accidentally
correct.

**Alternatives considered.** I considered hand-rolling type guards instead
of zod, but zod was already a dependency and the doc explicitly calls for
it here; a schema is also the single place the shape of a valid query now
lives, instead of scattered casts.

**Regression test.** `GET /trials query validation` in `routes.test.ts`:
`?search[a]=b`, `?phase=I&phase=II`, `?minEnrollment=abc`, and `?sort=bogus`
each must return 400 (all currently return 500 or 200 on the old code), and
`?minEnrollment=0` must return all 8 trials with a 200.

## B9 - Build is broken by a types mismatch

**How I found it.** `package.json` pairs `express ^4.21` with
`@types/express ^5.0` — a major-version mismatch between the runtime and
its type definitions. `tsc --noEmit` failed on `routes/trials.ts` lines 16,
30, and 39 as the design doc predicted exactly.

**Impact in production.** `npm run build` (and, until this fix, there was
no `typecheck` script at all) failed outright, which means either CI
wasn't actually type-checking this project or the build step was being
skipped — either way, the strict `tsconfig` settings (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, etc.) were giving a false sense of safety
while not actually running.

**Fix.** `package.json` — pinned `@types/express` to `^4.17.21` to match
the installed `express ^4.21`, and added a `typecheck` script
(`tsc --noEmit`) so this class of failure is checked on every commit going
forward. The two remaining errors after the pin (both `exactOptionalPropertyTypes`
violations from the query-cast pattern) were resolved as part of the B8
fix, since building the `filters` object from the zod-parsed query with
conditional spreads is what actually eliminates them — pinning the types
package alone wasn't sufficient.

**Why it is correct.** `npm run typecheck` now passes with zero errors,
and the fix targets the actual mismatch (types vs. runtime major version)
rather than suppressing the errors with `// @ts-expect-error` or loosening
`tsconfig`.

**Regression test.** There isn't a unit test for this one, deliberately —
`npm run typecheck` (now a first-class script) is the right tool for this
class of bug: a type/build-time invariant, not a runtime behavior. Adding a
"test" that just calls `tsc` would be redundant with the script itself and
with the "must pass after every commit" rule already in force.

## Minor observations (not counted)

- The efficacy-focus prompt branch in `buildPrompt` prints the response
  rate without a `%` sign (`${trial.responseRate ?? "not yet available"}`),
  unlike the header line a few lines below it, which does include one. Not
  fixed — cosmetic, and outside the "minimal fix" scope for this doc.
- `listTrials` reads the mutable `trialData` array while `getTrialById`
  reads the `trialCache` `Map` built once from it at module load. These are
  two sources of truth today only in principle, since nothing currently
  mutates `trialData` after the freeze added in B5 — but they would
  diverge the moment data becomes mutable at runtime (e.g. once trials move
  behind a database, per the ADR).
- The `analyze` route handler's response is typed `Response<ErrorResponse>`
  but is used almost entirely as a raw SSE stream (`response.write` with
  `data: ...` strings), not as JSON — the type only actually applies to the
  early 404/400 exits.

## Not fixed, on purpose

- **Endpoint-aware risk scoring** (flagged in B7): response rate is a weak
  signal for survival-endpoint trials like RADIANT-4. The correct fix
  requires knowing which endpoint type a trial uses and weighting
  accordingly — a real feature, not a bug fix.
- **Relevance-ranked search** (flagged in B5): the `_score` value that B5
  now keeps in a local `Map` is exactly what the original author appears to
  have intended to sort search results by, but never used. Wiring it up to
  actually rank results is a feature addition I kept out of a "minimal
  fix" bug report.
- **A JSON error middleware in `app.ts`** (mentioned as optional hardening
  under B2): so no route ever returns Express's default HTML stack trace on
  an unhandled exception. B2's specific crash is fixed at the source, so
  this is now a defense-in-depth improvement rather than a fix for a
  reproduced bug, and I kept the change surface to what B2 actually
  required.
