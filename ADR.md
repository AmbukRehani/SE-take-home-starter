# ADR-001: Batch re-analysis execution model

Status: Proposed
Date: 2026-09-24
Author: Ambuk Rehani

## Context

Analysts need to re-run AI analysis across all trials (or a filtered
subset) when a competitive-landscape report is published or analysis
criteria change, and the results need to be stored so they can be
reviewed and queried later — not just streamed and discarded, the way
the existing single-trial `/trials/:id/analyze` endpoint works today.

**Neither option in the architecture prompt actually exists yet.**
`data.ts` is an in-memory array; there is no database in this codebase.
Option A's `batch_jobs` table and Option B's "pg-boss using the existing
Postgres" both assume a Postgres instance that isn't there. That cuts
both ways: it removes most of Option B's "no new infra" argument (pg-boss
still needs that Postgres to exist first), and it removes most of Option
A's "no new infra" argument too (a DB-backed job table is itself new
infrastructure). Whichever option wins, step one is standing up Postgres.

**Throughput.** At 500 trials, ~30s average per analysis, 5 concurrent
workers: `500 × 30 ÷ 5 = 3000s ≈ 50 minutes` per batch. At 10 concurrent:
`500 × 30 ÷ 10 = 1500s ≈ 25 minutes`. Either fits comfortably inside a
2–3-times-a-week cadence with room to spare.

**The 500 RPM rate limit is not binding.** 5 concurrent jobs at 15–45s
each is `5 × (60 ÷ 15)` to `5 × (60 ÷ 45)` ≈ **7–20 requests per minute** —
nowhere close to 500. Concurrency, not the rate limit, is what would ever
need to grow.

**The $200/month budget is not binding at today's model and scale.** I
re-checked current pricing rather than trust a number from a stale
source: `gpt-4o-mini` is **$0.15 per 1M input tokens and $0.60 per 1M
output tokens** (verified 2026-09-24 against OpenAI's pricing page and
cross-checked against a second source). At roughly 1k input + 600 output
tokens per analysis, that's `(1000 × $0.15 + 600 × $0.60) ÷ 1,000,000 ≈
$0.00051` per analysis. `500 trials × 3 focuses × 3 batches/week × 4.3
weeks/month ≈ 19,350 analyses/month`, so `19,350 × $0.00051 ≈ $9.87` —
call it **~$10/month**, about 5% of the budget. The real budget risk
isn't this workload, it's a *model upgrade*: swapping to a frontier model
later could multiply the per-analysis cost 10–30×, which would actually
start to matter against the cap.

**Event-loop contention is mostly a myth for this workload.** An AI call
is an awaited HTTPS stream; the process spends almost no CPU time on it
between chunks. What actually threatens the single-process API is
**memory** (small here — a few hundred KB of in-flight prompt/response
text at a time, not a concern at this scale) and **process restarts**:
every deploy kills whatever's in flight, batch or not.

**"Results must be queryable" is a requirement on the output's shape, not
on the queue.** "Show me all trials where the safety analysis flagged
high risk" needs a structured field to filter on, not a smarter queue.
Batch jobs should call `generateObject` with a zod schema (e.g.
`{ riskLevel: "low" | "medium" | "high", flags: string[], summary: string }`)
and store the structured output alongside the raw text. This applies
identically whichever option below is chosen, and is worth calling out
because it's easy to conflate "we need structured queries" with "we need
a fancier queue" — they're independent problems.

## Decision

**Option A, with one change: the database table is the queue, not an
in-memory structure.** `analysis_jobs` rows, claimed with `SELECT ... FOR
UPDATE SKIP LOCKED` and a lease column, are the single source of truth
for what's pending, in flight, or done — there is no separate in-memory
queue to lose on a crash and reconcile against the DB afterward. The
worker loop (the claim query, the per-job timeout, the retry policy) is
written as a self-contained function so it can be lifted into its own
process (Option B) later without a schema change, if and when the
reversal conditions below are actually met.

## Rationale

1. It meets every stated constraint at 500 trials with one process, one
   deployable, and one place to debug — which matters directly for a team
   without a worker fleet today.
2. A DB table as the queue (rather than an in-memory one) gives crash
   recovery, idempotency (the unique constraint on
   `batch_id + trial_id + focus` prevents double-claiming), and a single
   source of truth for progress — for free, using infrastructure the
   project needs anyway for storing results. This directly removes the
   "in-memory queue lost on crash" weakness the architecture prompt lists
   against Option A.
3. Progress updates are cheaper in-process: an `EventEmitter` feeding an
   SSE endpoint in real time is simpler than round-tripping through an
   external queue's pub/sub, with the DB as the fallback for a client that
   reconnects mid-batch.
4. It keeps the later move to Option B cheap rather than foreclosing it:
   the job table's schema, the `SKIP LOCKED` claim query, and a
   `runAnalysisJob()` function that takes a claimed job and executes it
   are *exactly* what a separate worker process would import and run
   unchanged. Choosing Option A now doesn't lock in a rewrite later — it
   defers a process-topology decision until there's a concrete reason to
   make it.

## Consequences

**Positive**
- No new infrastructure beyond Postgres, which the project needs anyway
  to store results and move `data.ts` out of memory.
- One deployable to operate, monitor, and debug.
- Crash-safe: an interrupted job's lease expires and gets reclaimed on the
  next boot instead of vanishing.
- The `runAnalysis(trial, focus, { signal })` function extracted for the
  batch is the same function the streaming endpoint uses, so their
  prompts can't silently diverge over time.

**Negative**
- **Deploy coupling.** Every API deploy kills in-flight jobs — up to
  `concurrency × 45s` of paid work lost and retried per deploy. If the
  team deploys several times a day, some fraction of batches will always
  be interrupted mid-run. This is the single biggest real cost of Option
  A and I don't think it should be minimized (see "strongest case for B"
  below).
- Batch work and ad-hoc single-trial requests share one process's memory
  and (in principle) its event loop, though per the event-loop analysis
  above this is a much smaller risk than the architecture prompt implies.
- Hand-rolled lease/retry logic is exactly the kind of code where subtle
  double-processing bugs live — and this candidate has just spent Part 1
  of this exercise finding bugs of precisely that shape (shared mutable
  state, race conditions). I'm choosing to accept that risk here because
  the `SKIP LOCKED` + unique-constraint pattern is a well-worn one, not
  because the risk is zero.

## Strongest case for Option B

**Deploy coupling**, restated as the strongest argument for the other
side: in Option A, every API deploy kills in-flight jobs, so any team
that deploys more than a couple of times a day will interrupt batches
routinely, not as an edge case. `pg-boss` also brings tested retry,
backoff, and dead-letter behavior instead of code this candidate would
have to write and verify by hand. Given that Part 1 of this exercise was
nine bugs found by actually running the code, not by reading it, I take
seriously that hand-rolled concurrency and lease logic is exactly where
the next bug like that would hide.

## When we would revisit

- **The API runs as more than one instance.** Every instance would run
  the claim loop; `SKIP LOCKED` still makes that *correct* (no double
  processing), but at that point it's accidental distributed computing,
  and a dedicated worker (Option B) is the honest design for it.
- **API p99 latency measurably degrades during a batch** — the load test
  in the implementation plan below is what would actually surface this,
  rather than assuming it from first principles.
- **Batches grow past roughly 2,000 jobs, or start overlapping regularly**
  (a new batch kicked off before the last one finishes).
- **A more expensive model** makes each interrupted-and-retried job
  meaningfully costly instead of a rounding error.
- **Deploys are frequent enough that more than ~10% of batches get
  interrupted** — at that point the deploy-coupling cost from the
  "Consequences" section above stops being a footnote and becomes the
  dominant operational cost of this design.

## Implementation plan

1. **Data layer.** Introduce Postgres with migrations; move `data.ts`
   into a `trials` table. Add `batches` (id, status, filters, focus,
   created_at, totals), `analysis_jobs` (batch_id, trial_id, focus,
   status `queued | running | succeeded | failed | cancelled`, attempts,
   lease_expires_at, error, unique on `batch_id + trial_id + focus`), and
   `analysis_results` (job_id, structured output, raw text, model, token
   counts). Extract one `runAnalysis(trial, focus, { signal })` function
   that both the existing streaming endpoint and the batch worker call,
   so their prompts can never diverge.
2. **Runner.** A claim loop using `SELECT ... FOR UPDATE SKIP LOCKED`, a
   semaphore (default 5, configurable), a 90s per-job timeout via
   `AbortSignal.timeout`, and 2 retries with backoff for 429/5xx only (not
   for validation-shaped failures). A single failed job never stops the
   batch. On boot, reclaim `running` jobs whose lease has expired. On
   `SIGTERM`, stop claiming new jobs, give in-flight jobs a grace period
   to finish, then release their leases for the next boot to pick up.
3. **API.** `POST /batch/analyze` returns 202 with a batch id;
   `GET /batch/:id/progress`; `GET /batch/:id/events` (SSE, fed by the
   in-process `EventEmitter`, with the DB as the source of truth for a
   client that reconnects); `POST /batch/:id/cancel`;
   `GET /analysis-results?focus=safety&riskLevel=high` (the structured
   `generateObject` output is what makes this query possible).
4. **Guardrails and observability.** A per-batch cost estimate before it
   starts, and a hard monthly budget cap that pauses new claims once hit;
   metrics for jobs-per-minute, failures by error class, and tokens per
   batch — these are what would actually catch a model-upgrade cost
   surprise before it becomes a $200/month overage.
5. **Load test.** Run 500 jobs against a mock model with realistic
   15–45s latency, measuring API p99 during the batch. This is the
   concrete evidence that either confirms Option A is fine at this scale,
   or triggers the move to Option B under the "when we would revisit"
   conditions above — not a guess made once and never checked.
