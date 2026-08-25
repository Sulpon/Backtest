# Roadmap

Living development roadmap for the forex backtesting/discretionary-trading
platform. Companion to `docs/ARCHITECTURE.md` — that document describes
what exists; this one describes the order in which it grows and why.
Update this file as phases complete or scope changes; it is meant to stay
current, not to be a one-time plan.

**Ground rule for every phase below:** unless a phase's own section says
otherwise, the components listed as STABLE in `docs/ARCHITECTURE.md`
(Pine interpreter core, DuckDB/FastAPI read path, `DataLayer.ts`, replay
engine, Zustand pattern, drawing model, `marketStructure/` schema, Vercel
deployment setup) are extended, not rewritten, in every phase.

---

## Phase 1 — Consolidate & Document

**Status: Complete (verified 2026-08-26).**

**Objective.** Produce a durable, accurate architecture reference
(`docs/ARCHITECTURE.md`) and this roadmap, so every later phase has a
written source of truth to plan against and check itself against.

**Why it's needed.** The audit found code comments repeatedly citing an
"architecture doc" that does not exist anywhere in the repository, two
unreconciled market-structure truth sources with no written rule governing
them, and no explicit statement of which subsystems are safe to build on
versus which are prototypes. Planning Phases 2-8 without fixing this first
risks re-litigating the same architectural questions in every phase, or
worse, silently violating a convention (e.g. treating Pine-runtime
structure as ground truth) that was never written down.

**Dependencies.** None — this is the root of the roadmap.

**Major components affected.** Documentation only: `docs/ARCHITECTURE.md`,
`ROADMAP.md`. No application code.

**Verification criteria.**
- `docs/ARCHITECTURE.md` exists and covers every subsystem listed in the
  audit (frontend, backend, data flow, Pine, drawing, market-structure,
  journal, Telegram, backtest, market-data provider layer, persistence,
  deployment, testing).
- `ROADMAP.md` exists with all 8 phases, each stating objective, rationale,
  dependencies, affected components, verification criteria, and
  do-not-change constraints.
- Explicit source-of-truth rules exist in writing for: market data, market
  structure, trades, drawings, journal data, evaluation ground truth.
- Both documents are internally consistent with the actual repository state
  (verified by re-reading them against the code, not just against each
  other).

**What must NOT change.** No application source code, dependencies,
database schema, or tests. No files deleted or moved.

---

## Phase 2 — Connect Market Data Providers

**Status: Needs human decision (provide real OANDA/FXCM credentials for full production verification, or explicitly accept mocked-provider verification as sufficient for now) — core connectivity verified 2026-08-25, see note below.**

**Objective.** Wire the existing `backend/app/marketdata/` provider layer
(FXCM/OANDA, incremental sync, validation) into the live API, so the app
can serve provider-synced data instead of only the static, one-time
CSV-derived `candles` table.

**Why it's needed.** Historical data today is a frozen snapshot (whatever
was in the root CSVs when `build_db.py` last ran). A real platform needs a
path to current/updateable market data without a manual CSV
export-and-rebuild cycle every time. The provider layer already does the
hard part (incremental sync, candle validation, timeframe aggregation) —
the gap is purely connective.

**Dependencies.** Phase 1 (the source-of-truth rule for market data must be
decided and written before this phase silently changes what `/api/dataset`
reads from).

**Major components affected.**
- `backend/app/marketdata/*` (extended, not rewritten — add a FastAPI route
  that calls `MarketDataService`)
- `backend/app/main.py` (new route(s), e.g. a way to request provider-synced
  data, or a documented decision to keep it separate from `/api/dataset`)
- `backend/app/db.py` / schema (additive only — new tables or columns)
- `DataLayer.ts` (frontend consumer of whatever new route exists)
- `docs/ARCHITECTURE.md`'s "Market data" source-of-truth rule (must be
  updated in the same change that connects this layer — the rule currently
  explicitly forbids merging `market_candles` into `candles` silently)

**Verification criteria.**
- ✅ A documented, explicit decision exists for how provider-synced data
  relates to `build_db.py`-produced data: separate endpoint entirely
  (`GET /api/marketdata/status`, `GET /api/marketdata/candles`), never
  merged into `/api/dataset` — documented in `docs/ARCHITECTURE.md`'s
  market-data source-of-truth rule.
- ✅ Existing `/api/dataset` behavior for EURUSD/GBPUSD/XAUUSD is unchanged —
  `main.py`'s existing route/handler is untouched; the full existing
  `test_dataset_windowing.py` suite still passes.
- ✅ `sync_market_data.py`'s existing CLI behavior still works — untouched,
  uses the same `MarketDataService` path the new routes call.
- ✅ New backend tests cover the new route(s)
  (`tests/test_marketdata_routes.py`, 10 tests against a mocked provider +
  temp DuckDB); all 68 pre-existing backend tests still pass (78/78 total).
- ✅ `data.duckdb`'s destructive `build_db.py` rebuild and any live provider
  sync do not race or corrupt each other: `build_db.py` is unmodified and
  stays a manual, offline operation; nothing in the new routes' request
  path invokes it. The explicit rule (deleting `data.duckdb` also discards
  synced `market_candles` data, so re-sync after a rebuild) is documented
  in `docs/ARCHITECTURE.md`'s risk list.
- ⏳ **Outstanding, not yet verified:** real OANDA/FXCM credentials. All
  tests above use a mocked `MarketDataProvider` (no network calls) — the
  actual HTTP request/response handling in `providers/oanda.py` and
  `providers/fxcm.py` (unchanged by this phase, but never yet exercised
  against a live account through the new routes) still needs a real
  practice-account run of `GET /api/marketdata/candles` before this is
  called production-verified end-to-end.

**What must NOT be changed.** The Pine interpreter, replay engine,
DuckDB/FastAPI read path's existing endpoints' response shapes, or the
Vercel deployment model (provider sync stays a local/offline-triggered
operation unless a specific decision is made to run it on Vercel, which has
no persistent filesystem — see `docs/ARCHITECTURE.md`'s Telegram section
for why that matters).

---

## Phase 3 — General Backtesting Engine

**Status: Not started.**

**Objective.** Generalize `run_backtest()` (currently one hardcoded
SMC/fib-OTE strategy, EURUSD 1h only, run once at build time) into a
strategy-parameterized engine that can run against any symbol/timeframe on
demand.

**Why it's needed.** This is the single largest gap identified in the
audit. Without it, "backtesting engine" in the target platform description
remains one fixed script, not a platform capability. Phases 4 (Pine
`strategy()`) and 6 (evaluation) both need a general engine to build on —
Phase 6 in particular needs to be able to run *many* strategy variants
against ground truth, which a one-off build-time script cannot do.

**Dependencies.** Phase 1 (trades source-of-truth rule). Does not strictly
depend on Phase 2, but benefits from it (more symbols/timeframes worth
backtesting once more data is connected).

**Major components affected.**
- `backend/app/structure_engine.py` — `run_backtest()`'s logic extracted
  into a parameterized, callable engine (strategy config in, trade list +
  stats out), decoupled from being a `build_db.py`-time side effect only.
- New backend module/route for on-demand backtest execution (distinct from
  the existing build-time path — the existing EURUSD 1h precomputed result
  can remain as-is, seeded by the same underlying logic, per "preserve
  current working architecture unless there is a demonstrated reason to
  change it").
- `backend/app/db.py` schema — additive (e.g. a way to store multiple named
  backtest runs, not just one `trades` table keyed by symbol alone).
- Frontend: a way to trigger/configure a backtest and view its results
  (new UI, likely a new Zustand store following the established pattern).

**Verification criteria.**
- The existing EURUSD 1h precomputed backtest's trades/stats are
  reproducible byte-for-byte (or with an explicitly documented, deliberate
  difference) through the new general engine — this is the regression
  check that proves generalization didn't silently change the one strategy
  already in production use.
- The engine can run against at least one other symbol/timeframe combo with
  a configurable parameter (e.g. `RR_RATIO`) and produce a distinct,
  sensible result.
- New tests cover the parameterized engine directly (not just the old
  fixed-config path).
- Existing 68 backend tests still pass.

**What must NOT be changed.** The Pine interpreter (this phase is Python
backend work, not Pine); `data.duckdb`'s existing `candles`/SMC-event tables
and their consumers; the existing `/api/dataset` response shape for
already-deployed symbol/timeframe combos, unless the strategy's own
regression check (above) explicitly signs off on a difference.

---

## Phase 4 — Pine `strategy()` Semantics

**Status: Not started.**

**Objective.** Add real Pine `strategy()` semantics to the interpreter —
automatic position tracking, entries/exits, position sizing, equity curve —
as a first-class alternative to today's manual `backtest.recordTrade()`
convention, where a script must hand-roll its own entry/exit loop.

**Why it's needed.** Today, only `smc.pine`-style scripts that implement
their own bookkeeping can report trades at all. Real Pine strategy scripts
(the kind a user might write or import from TradingView) use `strategy.*`
calls the interpreter doesn't understand. Without this, "Pine indicator
execution" stays indicator-only, and the general backtesting engine from
Phase 3 has no way to let a *user-authored Pine script* define a strategy
rather than only Python-side strategy configs.

**Dependencies.** Phase 3 (a general engine concept should exist before
wiring a second strategy-authoring path into it) and Phase 1 (the
trades source-of-truth rule explicitly requires Phase 3/4 to define how a
general engine's trades relate to Pine-self-reported trades before they're
treated as one concept).

**Major components affected.**
- `src/pine/stdlib.ts` — new `strategy.*` namespace (`strategy.entry`,
  `strategy.close`, `strategy.exit`, position-size inputs, etc.), additive
  alongside the existing non-standard `backtest.*` namespace (which stays,
  for scripts already using it — see "must not change" below).
- `src/pine/interpreter.ts` — position/equity state tracking during a run,
  additive to the existing per-run state (lines/boxes/labels/plots/trades
  registries already exist as a pattern to follow).
- `src/pine/pine.worker.ts`, `usePineIndicators.ts` — likely unaffected in
  shape (same request/response contract), but should be re-verified once
  `strategy()` scripts can be meaningfully heavier to execute than
  `indicator()` scripts.
- Pine test suite (`interpreter.test.ts`, `compiler.test.ts`) — new test
  coverage for `strategy.*` semantics.

**Verification criteria.**
- A real Pine `strategy()` script (not using `backtest.recordTrade()`) can
  be loaded and produces a correct trade list/equity curve, verified
  against a hand-computed or TradingView-cross-checked example.
- Existing `backtest.*`-based scripts (`smc.pine`) continue to work
  unchanged — this is a regression check, not an assumption.
- The profiling discipline from the existing Pine perf work is followed:
  any interpreter change here should be checked for byte-identical output
  on unaffected scripts, the same way the dispatch-cache work in the
  interpreter's perf pass was verified.

**What must NOT be changed.** The lexer/parser/AST core structure (this is
additive stdlib + interpreter state, not a parser rewrite); the existing
`backtest.*` namespace and its behavior (scripts depending on it must keep
working); the Pine worker's message contract, unless a specific, documented
reason requires changing it.

---

## Phase 5 — Persistent Trading Data

**Status: Not started.**

**Objective.** Move journal, drawings, and market-structure ground-truth
data off `localStorage`-only persistence onto durable, server-side storage
(DuckDB or a dedicated lightweight store), while preserving the existing
client-side stores' APIs where practical.

**Why it's needed.** The audit's persistence-model finding: everything a
trader would consider "their data" is currently browser-local only, with no
durability against a browser reset and no cross-device story. Phase 6
(evaluation) depends on the `marketStructure/` ground-truth dataset being
reliably available — building an evaluation system on top of data that can
vanish with a cleared browser profile is a foundation problem, not a
feature gap.

**Dependencies.** Phase 1 (persistence model must be documented as a named
risk before being addressed — done). Does not strictly depend on Phases 2-4,
but should happen before Phase 6 for the reason above.

**Major components affected.**
- `journalStore.ts`, `drawingStore.ts`, `marketStructureStore.ts` — their
  Zustand `persist` middleware's storage backend changes (or gains a sync
  layer to a backend store); the store *interfaces* used by components
  should change minimally, per "preserve current working architecture
  unless there is a demonstrated reason to change it."
- Backend: new schema/tables for journal entries, drawings, and
  market-structure events, plus routes to read/write them.
- Migration path for existing `localStorage` data (a one-time import, not a
  silent data loss).

**Verification criteria.**
- Existing frontend behavior (journal notes, drawings, market-structure
  logging) is unchanged from the user's perspective — same UI, same
  interaction, different storage underneath.
- A documented migration path exists and is tested: existing
  `localStorage` data for a real browser profile can be imported without
  loss.
- New backend tests cover the new persistence routes.
- The market-structure export format (`MarketStructureDataset` JSON)
  remains valid and unchanged, since Phase 6 and any external tooling may
  already depend on its shape.

**What must NOT be changed.** The `DrawingObject`/`DrawingKind` model, the
`MarketStructureEvent`/`FibonacciEvent` schema shapes (storage location
changes; the schema itself is the Phase-1-documented ground-truth format
and should not be redesigned here), the Zustand-per-concern pattern.

---

## Phase 6 — Indicator-vs-Ground-Truth Evaluation

**Status: Not started.**

**Objective.** Build the comparison/scoring layer that evaluates
engine/Pine-detected market structure (or a Phase-3/4 backtest's trades)
against the user's manually recorded ground truth in `src/marketStructure/`.

**Why it's needed.** This is a named goal of the target platform and the
reason `src/marketStructure/` was built with such a deliberately measured,
non-inferring schema in the first place. Without it, the manual logger is
pure data collection with no payoff.

**Dependencies.** Phase 1 (the explicit rule that ground truth is
*only* `marketStructure/` records, never DB-precomputed or Pine-runtime
structure — already written). Phase 5 strongly recommended first (ground
truth should be durable before it's the basis of evaluation scoring).
Benefits from Phase 3/4 (more strategies to evaluate) but can start with
just the existing DB-precomputed/Pine-runtime structure as the "indicator"
side.

**Major components affected.**
- New module, e.g. `src/evaluation/` — reads `marketStructure/` records as
  ground truth, reads DB-precomputed or Pine-runtime structure (or Phase
  3/4 backtest trades) as the "indicator" side, and defines match/scoring
  logic (e.g. did a BOS the engine detected correspond to one the user
  manually logged as `valid`, within what time/price tolerance).
- `AnalysisHub.tsx` or a new panel to surface evaluation results.
- Likely a new Zustand store (`evaluationStore.ts`, following the
  established pattern) if evaluation results need to be interactive/cached
  client-side; or a backend endpoint if scoring is expensive enough to
  belong server-side (decide explicitly, document the decision here or in
  `docs/ARCHITECTURE.md`).

**Verification criteria.**
- Evaluation logic never treats DB-precomputed or Pine-runtime structure as
  ground truth — this is directly checkable against
  `docs/ARCHITECTURE.md`'s explicit rule and should be part of code review
  for this phase, not just a design intention.
- A concrete evaluation run against real logged ground-truth data (even a
  small manually-created set) produces sensible, explainable match/mismatch
  output — not just a score, but which specific ground-truth event matched
  or didn't and why.
- `marketStructure/`'s schema is read, not modified, by this phase (per
  Phase 1's rule: reuse it, don't build a second one).

**What must NOT be changed.** The `marketStructure/` collection schema and
UI (this phase consumes it; changes to the collection side, if needed,
belong in whatever phase is doing that work, not silently bundled here);
the DB-precomputed/Pine-runtime structure computations themselves (this
phase evaluates their output, it doesn't change how they compute it).

---

## Phase 7 — Drawing/Analytics Expansion

**Status: Not started.**

**Objective.** Fill in the remaining 25 non-live drawing tools
(channels, most Fibonacci variants, shapes beyond rectangle, annotations,
brushes, `riskreward`) and build out performance-analytics views (equity curves,
drawdown, win-rate/expectancy breakdowns beyond the current `StatsPanel`)
against the by-then-general backtest engine and evaluation system.

**Why it's needed.** Named goals of the target platform ("drawings and
chart tools," "performance analytics") that are additive UI/feature work
against infrastructure that should be stable by this point — lower risk,
and better done once the underlying trade/evaluation data model (Phases 3,
4, 6) has settled, so analytics views aren't built against a shape that
changes underneath them.

**Dependencies.** Phase 3 (backtest engine) and Phase 6 (evaluation) for
analytics that reference them; the drawing-tool expansion itself has no
hard dependency beyond Phase 1 and can proceed opportunistically alongside
earlier phases if desired — it doesn't block or get blocked by Phases 2-6
in the same way they block each other.

**Major components affected.**
- `src/drawing/kinds.ts` — new `DrawingKind` entries per tool, following
  the existing registry pattern (one entry per tool, no framework changes).
- `src/components/toolDefinitions.ts` — flip `live: false` to `live: true`
  as each tool is wired.
- New analytics components (likely under `src/analysis/` alongside
  `AnalysisHub.tsx`) consuming Phase 3's general backtest output and Phase
  6's evaluation output.

**Verification criteria.**
- Each newly-live tool has the same "one `DrawingKind` entry + one
  `toolDefinitions.ts` entry" shape as the existing 15 — no new drawing
  architecture introduced.
- New analytics views are read-only consumers of existing data (backtest
  results, evaluation results) — they compute presentation, not new source
  data.
- Existing drawing/analytics tests and behavior are unaffected for
  already-live tools.

**What must NOT be changed.** The generic `DrawingObject`/`DrawingKind`
model itself (this phase populates it, doesn't redesign it); existing live
tools' behavior.

---

## Phase 8 — Trading Logic / Indicator Research Agent

**Status: Not started.**

**Objective.** Close the loop: an agent-assisted (or structured manual)
workflow that takes the user's own recorded trading behavior, turns it into
measurable hypotheses about indicator/strategy logic, tests those
hypotheses against history, and only accepts a change once it's verified
not to regress what already worked.

**Why it's needed.** This is the platform's ultimate stated purpose — not
just recording and backtesting, but using the recorded ground truth to
actually improve the trading logic over time, with discipline against
overfitting or silently breaking something that worked before.

**Dependencies.** All of Phases 1-6 — this phase is the composition of
everything before it (ground truth collection, a general backtest engine,
Pine strategy execution, durable data, and evaluation scoring) into one
workflow. Phase 7 is not a hard dependency (analytics UI polish isn't
required for the loop to function) but makes the loop's output legible to
the user.

**Major components affected.** Primarily orchestration — this phase is
less about new subsystems and more about sequencing existing ones (Phase
3's engine, Phase 4's `strategy()` support, Phase 6's evaluation) into a
repeatable loop, plus whatever new surface (UI or CLI) drives that loop and
records its own history (which hypotheses were tried, accepted, or
rejected, and why — itself a durable record per Phase 5's persistence
model).

**The loop, explicitly:**

```
 1. manual trading data        the trader's own recorded activity:
    (journal + marketStructure  entries/exits, notes, and manually
     drawn structure)           classified BOS/CHoCH/Fibonacci events

 2. → ground truth              Phase 6's designated ground-truth source:
                                 src/marketStructure/ records, nothing else

 3. → indicator                 the Pine script or engine-side strategy
                                 currently under test (Phase 3/4 output)

 4. → backtest                  run that indicator/strategy through the
                                 general engine (Phase 3) — or, for a Pine
                                 strategy, through strategy() semantics
                                 (Phase 4) — across the relevant history

 5. → evaluation                Phase 6's scoring: how well did the
                                 indicator's detected structure/trades
                                 match the ground truth in step 2

 6. → failure analysis          where and why the indicator diverged from
                                 ground truth — specific missed/false
                                 structure events or trades, not just an
                                 aggregate score

 7. → hypothesis                a specific, falsifiable proposed change
                                 ("require close confirmation before BOS,"
                                 "widen the equal-high tolerance") derived
                                 from the failure analysis, not a guess

 8. → code modification          implement the hypothesis (Pine script edit
                                 or engine parameter/logic change) — scoped
                                 to exactly the hypothesis, nothing else

 9. → backtest                  rerun step 4 with the modification

10. → regression check          compare against the PRE-modification
                                 backtest/evaluation results (not just the
                                 new run in isolation) — the modification
                                 must not silently make previously-correct
                                 behavior worse elsewhere in history

11. → accept/reject             accept only if the hypothesis's targeted
                                 failure improved AND the regression check
                                 passed; reject (revert) otherwise. Either
                                 outcome is recorded (Phase 5's durable
                                 storage) so the same hypothesis isn't
                                 re-tried blind next time.
```

This loop is deliberately falsification-oriented: step 10's regression
check is not optional and is the mechanism that prevents this phase from
degrading into curve-fitting against the very ground truth it's supposed to
be validated by.

**Verification criteria.**
- The loop can be run end-to-end at least once against a real (even small)
  ground-truth dataset, producing a recorded accept/reject decision with
  its supporting evaluation numbers.
- The regression check (step 10) is demonstrably load-bearing — i.e., there
  exists a test case where a hypothesis improves the targeted failure but
  is correctly rejected because it regresses something else.
- Every accepted or rejected hypothesis is durably recorded (per Phase 5),
  not just logged to a terminal/console and lost.

**What must NOT be changed.** Ground truth (`marketStructure/` records)
is never modified by this loop — it is only ever read as the fixed
reference the loop is validated against; if the loop needs more ground
truth, that's a return to step 1 (recording more manual data), never
synthesizing or adjusting existing ground-truth records to make a
hypothesis look better. The Phase 6 evaluation logic itself is not
altered by this phase except through its own explicit maintenance process
— the loop consumes evaluation, it doesn't tune it to produce a desired
answer.

---

## Cross-phase notes

- **Status vocabulary (used by every phase's `Status:` line above), for the
  autonomous orchestrator (`.claude/skills/roadmap-next/`) to scan
  mechanically**: `Not started`, `In progress`, `Blocked (needs Phase N)`,
  `Needs human decision (<reason>)`, `Complete (verified <date>)`. The
  orchestrator selects the first phase without `Complete` status whose
  Dependencies are all `Complete`; a `Needs human decision` phase is
  reported to the human but does not block work on other unblocked phases.
- **Ordering is dependency-driven, not strictly sequential.** Phase 7's
  drawing-tool expansion, in particular, can proceed in parallel with
  Phases 2-6 if capacity allows — it has no hard dependency on them beyond
  Phase 1.
- **Every phase should update `docs/ARCHITECTURE.md`** when it changes a
  subsystem's status (PARTIAL → STABLE, PLANNED → PARTIAL, etc.) or adds a
  new source-of-truth rule. This roadmap describes intent; that document
  should always describe current reality.
- **Regression discipline established in the Pine performance work**
  (byte-identical-output verification before/after a change) is the model
  for every phase that touches an existing STABLE component — not just
  Phase 8's explicit regression-check step.
