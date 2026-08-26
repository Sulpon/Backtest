# Architecture

Durable reference for the repository as it exists today. This document
describes what is actually built and how it actually connects — not the
target platform (see `../ROADMAP.md` for where this is going). Written from
a full-repository audit on 2026-08-25; re-verify specifics (file paths, line
counts, table names) against the code before relying on them if this
document is old.

## Status legend

Every subsystem below is tagged:

- **STABLE** — mature, tested, should be extended, not rewritten.
- **PARTIAL** — real code exists but is incomplete or disconnected from the
  live app.
- **LEGACY** — superseded or prototype code, kept for reference only, not
  part of the running application.
- **PLANNED** — does not exist yet; named here only because other sections
  reference it.

## Repository structure

```
Backtest/                          (repo root)
├── terminal/                      STABLE — the active application
│   ├── src/                       frontend (Vite + React 19 + TypeScript)
│   ├── backend/                   backend (FastAPI + DuckDB)
│   ├── package.json               frontend deps/scripts
│   └── vercel.json                single-project Vercel deployment config
├── engine.py                      LEGACY — sandbox script, hardcoded paths, not runnable, not imported
├── smc_backtest_app.html          LEGACY — 5.8MB standalone prototype, predates terminal/
├── smc.pine / smc_tradingview.pine
│   / ludo_smc_with_bos_filters_1.pine
│                                  LEGACY/REFERENCE — loose Pine scripts, one (smc.pine or its
│                                  TradingView copy) is loaded as a live indicator via the app's
│                                  Pine editor; provenance/duplication between the three is unclear
├── *.csv (EURUSD/GBPUSD/XAUUSD,   STABLE (as an input) — raw MT4-style exports, read by
│   1m/5m/15m/30m/1h/4h/1d)        terminal/backend/build_db.py via a relative ../../ path
└── docs/, ROADMAP.md              this documentation
```

**Rule of thumb:** if it's not under `terminal/`, it is either a build input
(the CSVs) or legacy/reference material. All active development happens in
`terminal/`.

## Frontend architecture (`terminal/src/`)

Stack: Vite, React 19, TypeScript, `lightweight-charts` v5 (rendering),
`dockview-react` (multi-pane layout), Zustand (state), `oxlint` (lint),
Vitest (tests).

**State pattern — STABLE.** Every feature area owns one Zustand store,
several wrapped in `persist` middleware backed by `localStorage`:
`journalStore`, `analysisStore`, `drawingStore`, `replayStore`,
`marketStructureStore`, `pineIndicatorStore`, `settingsStore`,
`workspaceStore`, `uiStore`. New features should follow this convention
(one store per concern, `persist` only when client-side durability is
actually wanted) rather than introducing a different state mechanism.

Top-level composition: `App.tsx` → `AppShell.tsx` → `DockviewRoot.tsx`
(pane layout) → `ChartPane.tsx` (one per chart pane; owns the
`lightweight-charts` instance, overlays, and replay/Pine wiring for that
pane) plus sibling panels (`TradesPanel`, `StatsPanel`, `WatchlistPanel`,
`StatusBar`, `TopToolbar`, `LeftToolRail`, `CommandPalette`).

## Backend architecture (`terminal/backend/`)

FastAPI app (`app/main.py`) + DuckDB (`app/db.py`, `data.duckdb`). Two
distinct subsystems live here (see "Two market-structure/data pipelines"
below):

1. **The live read path** — `app/main.py` + `app/db.py` + `data.duckdb`. The
   only thing the running API ever touches. Never runs the backtest engine
   or touches a CSV at request time.
2. **The offline build path** — `build_db.py` + `app/structure_engine.py`.
   Run manually, on demand, whenever a CSV changes or the structure-detection
   logic changes. Drops and fully recreates `data.duckdb`.
3. **The market-data provider layer** — `app/marketdata/*` +
   `sync_market_data.py`, plus (as of Phase 2) `GET /api/marketdata/status`
   and `GET /api/marketdata/candles` in `app/main.py`. A separate pipeline
   with its own tables and routes, additive to (never merged into) the live
   read path above (see below).

## Data flow (end to end, current state)

```
CSV (repo root, static)
   │  build_db.py (manual, offline, destructive: drops+recreates data.duckdb)
   ▼
data.duckdb  (backend/, git-LFS tracked, read-only at request time)
   │  FastAPI: GET /api/symbols, /api/quotes, /api/dataset
   ▼
DataLayer.ts (frontend: fetch, in-memory cache, request dedup, windowing)
   │
   ├──► ChartPane.tsx (renders candles + DB-precomputed SMC overlays)
   ├──► Pine interpreter (worker) — independently recomputes its own
   │       swings/BOS/CHoCH/etc. from the SAME raw bars, at runtime
   ├──► Replay engine (scrub/seek over the same bar array)
   └──► Market-structure logger (measures against the same bar array)
```

`data.duckdb`'s `candles` table is populated *only* from the root CSVs via
`build_db.py`. The `marketdata/` provider layer (FXCM/OANDA) writes to its
*own* tables (`market_candles`, `instruments`, `data_sync_jobs`) via
`sync_market_data.py` (CLI) or the live `GET /api/marketdata/candles` route
(Phase 2) — neither path is read by `/api/dataset`, and `/api/dataset`'s
`candles` table is never written by either — see "Market-data provider
layer" below.

## Market-data flow — DuckDB's role

`data.duckdb` (~53MB, one file, git-LFS tracked) is the single source the
live API reads. Schema (from `backend/README.md`):

- `candles(symbol, timeframe, bar_index, time, open, high, low, close)`
- `swing_points`, `bos_events`, `fvg_events`, `volume_imbalance_events`,
  `liquidity_events` — DB-precomputed SMC structure, per symbol/timeframe
- `order_blocks`, `trades`, `stats` — **EURUSD 1h only**, output of the one
  hardcoded backtest (`run_backtest()`)
- `symbols` — the 3-symbol watchlist (EURUSD, GBPUSD, XAUUSD)

DuckDB is read-only at request time by design: "the database is the only
thing the API ever reads from — it never touches the CSV or runs the engine
live" (`backend/README.md`). **STABLE** — extend this schema (new tables,
new columns) rather than replacing the read model.

## FastAPI's role

`app/main.py` exposes a small, fully `/api/`-prefixed surface:

- `GET /api/symbols` — watchlist symbol/label pairs
- `GET /api/quotes?timeframe=` — last/prev close only (cheap, for the
  watchlist row, deliberately not `/api/dataset`)
- `GET /api/dataset?symbol=&timeframe=&limit=` — the full payload (candles +
  every SMC event table + trades/stats where applicable); `limit` returns a
  re-indexed windowed tail for fast-paint, always followed by an unwindowed
  request for the complete history
- `GET /api/telegram/status`, `POST /api/telegram/test`,
  `POST /api/telegram/send-trade` — Telegram trade-review integration,
  local-only

Middleware: CORS (configurable via `CORS_ALLOWED_ORIGINS`, defaults to Vite
dev origins), GZip (`compresslevel=4`, chosen from a measured level-by-level
benchmark — see `terminal/README.md#performance`). `/api/dataset` returns a
raw `JSONResponse` rather than going through Pydantic's `response_model`
encoder on the way out, specifically to skip ~350-420ms of redundant
validation on already-trusted DB output; `response_model` stays on the
decorator purely so `/docs` still reflects the real schema. **STABLE.**

## DataLayer's role (`src/data/DataLayer.ts`)

The frontend's single point of contact with the backend. Responsibilities:
in-memory caching per symbol/timeframe, request deduplication (one in-flight
request shared across callers, closing a prior double-fetch bug), and the
two-phase load (windowed fast-paint request immediately, full unwindowed
request concurrently, transparently replacing the windowed data when it
lands — skipped entirely on a warm cache hit). **STABLE.**

## Charting architecture

`lightweight-charts` v5, one instance per `ChartPane.tsx`, panes arranged
via `dockview-react` (`DockviewRoot.tsx`). `chartRegistry.ts` tracks live
chart instances (used by, e.g., `chartSnapshot.ts` for Telegram review
screenshots — composites the Pine indicator overlay canvas on top of the
base chart image via `chart.takeScreenshot()`). `chartTheme.ts` centralizes
light/dark styling. **STABLE.**

## Replay architecture (`src/replay/`)

`replayStore.ts` is the single source of truth for "what's visible right
now" — every other replay UI (`ReplayBar`, `ReplayTimeline`,
`ReplayDatePicker`, `ReplayCalendar`, `ReplaySetupMenu`) only calls its
transport actions (`seek`, `scrub`, `play`/`pause`, `first`/`last`,
`stepForward`/`stepBackward`, `bigStep*`, `seekToDate`). `ChartPane`
populates the store with the current dataset's shape (`setDataset`) and
reacts to cursor changes; nothing else touches bar data directly.
`jumpNonce` distinguishes a "reframe the viewport" jump from a one-bar
nudge. `scrub` moves the cursor without forcing a reframe (for smooth
dragging); `seek` forces one. **STABLE** — a future strategy tester should
drive itself off this same cursor rather than building a second stepping
mechanism.

## Pine interpreter architecture (`src/pine/`)

Real language implementation, ~5,000 LOC: `lexer.ts` → `parser.ts` (→
`ast.ts` node shapes) → `interpreter.ts` (tree-walking evaluator) with a
stdlib (`stdlib.ts`) covering `math.*`, `ta.*`, `array.*`, `str.*`,
`color.*`, `line.*`, `box.*`, `label.*`, `input()`, plus a non-standard
`backtest.*` namespace (see "Current backtest implementation" below). An
opt-in AST-to-closures compiled execution path exists (`compiler.ts`) as a
lower-risk alternative to full interpreter dispatch, alongside the default
tree-walker.

**Scope: indicator-only.** The interpreter supports Pine's `indicator()`
declaration and everything needed to draw/plot from one. It does **not**
implement `strategy()` semantics (position sizing, equity curve,
commission/slippage, multiple concurrent positions) — see "Current backtest
implementation."

Tested via `interpreter.test.ts` and `compiler.test.ts`. A profiling pass
(documented in `terminal/README.md#performance`) identified `evalExpr`
dispatch, `resolveArgs`, and `Scope.resolve` as the hot paths; scope/call
resolution caching was added and verified byte-identical against the
pre-change interpreter (4 trials). Known ceiling: per-variable history
arrays are unbounded (`O(bars)` per binding), the likely driver of
super-linear scaling at large bar counts. **STABLE — do not rewrite the core
dispatch model.** Any `strategy()` work (Phase 4) should be additive to
`stdlib.ts`/`interpreter.ts`, not a replacement.

## Pine worker/cache architecture

`pine.worker.ts` runs the full lex→parse→interpret pipeline off the main
thread — one message per `(indicator, bars)` run, matched back to the
caller by `requestId` (`usePineIndicators.ts`). Two cache layers sit in
front of it:

1. **In-memory** (`usePineIndicators.ts`'s `resultCache`) — survives the
   current session only, keyed loosely (can fall back to dataset-content-only
   fingerprinting for symbol-less preview call sites).
2. **Persistent** (`pineIndexedDbCache.ts`, IndexedDB) — survives page
   reloads. Key: `symbol:timeframe:indicatorId:scriptHash:inputOverrides
   JSON:startDate:datasetVersion` (`persistentCacheKey()`). Bounded to 12
   entries, LRU-evicted by a monotonic access counter (not wall-clock time,
   to avoid same-millisecond ties). Deliberately does **not** persist
   `windowedBars` (reconstructible from `bars` + `startDate` for free — would
   otherwise roughly double disk footprint per entry).

**STABLE.**

## Drawing system (`src/drawing/`)

Generic model: a `DrawingObject` (`types.ts`) is plain, JSON-serializable
data — `{ id, type, points[], style, props, meta?, locked, hidden, zIndex,
createdAt, updatedAt }`, no class instances or canvas references. All
tool-specific behavior (render, hit-test, draggable points) lives in a
`DrawingKind` descriptor looked up by `type` (`kinds.ts`) — adding a tool is
one `DrawingKind` entry + one `toolDefinitions.ts` entry, nothing else.

`toolDefinitions.ts` currently lists 40 tools across 10 groups
(navigation, lines, channels, fibonacci, shapes, annotations, risk tools,
market structure, measurement, brushes); **15 are `live: true`** (cursor,
crosshair, hand; trendline, hline, vline, ray; rectangle; fibretracement;
long, short; plus the 4 manual BOS/CHoCH tools) — the other 25 (all of
channels/annotations/measurement/brushes, most of lines/fibonacci/shapes,
and `riskreward`) are stubs. Non-live tools render in
the UI (correctly grouped, armable) but show a "not yet wired" hint instead
of drawing. Direction is baked into the `DrawingType` itself for
`bosbull`/`bosbear`/`chochbull`/`chochbear` (four distinct types, not one
type + a direction prop) so recording a manual structure call never
involves the platform inferring anything the user didn't explicitly pick.

Persisted to `localStorage` via `drawingStore.ts`'s Zustand `persist`.
**STABLE as a model** — extending live tool coverage is additive (new
`DrawingKind` entries), not a redesign.

## Market-structure logging (`src/marketStructure/`)

A **pure data-collection layer** (~1,200 LOC) over the 4 manual
`bosbull`/`bosbear`/`chochbull`/`chochbear` drawing tools. Every manually
drawn structure mirrors into a `MarketStructureEvent` record
(`types.ts`): full start/end geometry, measured `rangeCandles`/
`rangePercent`/`directionalMovePercent` (computed, never inferred), an
append-only `editHistory` of geometry revisions, a `userClassification`
(`valid`/`invalid`/`uncertain`/`null`), soft-delete status, and the original
`DrawingObject` preserved verbatim (`rawDrawing`). A parallel flat
`DrawingEventLogEntry` action log records create/edit/delete independent of
current-state records. `FibonacciEvent` records exist alongside for
manually drawn fib retracements. Exports to a versioned JSON dataset
(`MarketStructureDataset`, `marketStructureExport.ts`) — metadata +
`marketStructures[]` + `fibonacciEvents[]` + `drawingEvents[]`.

Nothing in this layer classifies, scores, or infers correctness — it only
measures facts that follow directly from what the user drew. **This is the
designated ground-truth collection system for the eventual evaluation
system (Phase 6) — reuse this schema, do not build a second one.**
Persisted to `localStorage` (same mechanism as `drawingStore`). **STABLE.**

## Journal (`src/journal/journalStore.ts`)

Notes/tags/1-5 star rating attached to a specific historical trade, keyed
by `tradeKey(symbol, entryBar)` (`"${symbol}:${entryBar}"` — a stable
identity because the current backtest only ever holds one open position at
a time, so no two trades share an entry bar *for that engine*; this
assumption should be revisited once Phase 3 allows overlapping trades).
Deliberately decoupled from the `Trade` type itself — backtest trades are
immutable, re-derived engine output; journal entries are separate,
persisted independently so re-running a backtest never loses notes.
`localStorage`-only, ~65 LOC. **STABLE as a model, PARTIAL as durable
storage** (see "Current persistence model").

## Telegram review system (`src/telegram/`, `backend/app/telegram/`)

Sends a closed trade (chart snapshot + entry/SL/TP/setup + YES/NO/PARTIALLY
buttons) to Telegram; the callback answer is saved server-side against that
trade. `TelegramService` (`backend/app/telegram/service.py`) never raises —
every method returns a result object, so a missing/misconfigured
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` degrades to "not configured"
everywhere without breaking anything else. **Local/self-hosted only** —
review answers need to persist server-side, and Vercel's serverless
filesystem doesn't persist between invocations (the same reason
`data.duckdb` is fetched fresh at *build* time, not runtime, on Vercel — see
`fetch_db.py`). Milestones 1-2 (connect/test, send-trade) are implemented;
snapshot compositing, callback handling, and journal-status surfacing are
further along per `terminal/README.md`'s milestone list — verify current
milestone against that README, which is the living record for this feature.
**PARTIAL** (by design, not by neglect — scoped deliberately to local use
for now).

## Current backtest implementation

`run_backtest()` (`backend/app/structure_engine.py`) is **one specific,
hardcoded SMC/fib-OTE strategy**: swing/BOS detection → daily-bias A/B/C/D
tagging (resampled from the same 1h file) → fib leg anchoring off the
latest impulse → OTE entry → SL at the leg extreme. It runs against
**EURUSD 1h only**, once, at `build_db.py` time, and its output is baked
into `data.duckdb`'s `order_blocks`/`trades`/`stats` tables.

As of Phase 3 Task 2, `run_backtest(csv_path, config: BacktestConfig |
None = None)` accepts an optional `BacktestConfig(rr_ratio: float = 2.45)`
— the *only* constant parameterized so far, per that phase's recorded
Decision 1. `build_db.py` calls it with no `config` argument, so its
output is unchanged (proven byte-for-byte by
`tests/test_backtest_regression.py`, written against the pre-Phase-3
signature). Every other constant (`DAILY_SWING_LEN`, `RETRACE_THRESHOLD`,
`SWING_LEN`, `MAX_IMPULSE_BARS`, `USE_LINE_SOURCE`, `FIB_USE_BODY`, the
inline `0.71` OTE anchor, the liquidity `tolerance_pct`, the fixed `-1.0`
loss R) is still hardcoded, and there is still no way to backtest a
genuinely different strategy without editing this function and rerunning
`build_db.py` — see `ROADMAP.md`'s Phase 3 for the remaining, larger tasks.

As of Phase 3 Task 3, `POST /api/backtest/run` (`app/backtest/runner.py` +
one route in `app/main.py`) runs the engine on demand against any
`(symbol, timeframe)` in a small local catalog, stateless — no persistence,
no DB schema (Task 4's scope). Its response carries only `{trades, stats}`
plus a *required* `validation: {status, validated, message}` object: only
EURUSD 1h is `"validated"` (any `rr_ratio`, per Phase 3 Decisions 2 and 5);
every other combo is `"experimental"` and explicitly labeled as such — the
route can never silently present an unchecked combo as a real backtest
result. `structure_engine.py`'s `pandas`/`numpy` dependency is imported
lazily, inside the route's call path, never at `app/main.py`'s module
scope, so a deployment without them (the current Vercel setup, per
Decision 4) still serves every other route and reports 503 only if this
one is actually invoked — the same "missing capability is a normal,
reportable state" pattern `/api/telegram/status` and
`/api/marketdata/status` already use. `build_db.py` is untouched by this
route (verified at zero diff); the route's `(symbol, timeframe)` catalog
is a second, independently-written literal cross-checked against
`build_db.CSV_FILES` by a test, not a shared import, to avoid coupling a
live route to the offline build script.

Separately, the Pine interpreter supports a **non-standard `backtest.*`
namespace** (`stdlib.ts`, `namespaces.backtest.recordTrade`) — not real
Pine syntax — that lets a script hand its own already-computed closed trade
(entry/exit/SL/TP/result/R/setup) to the host app's Trades panel /
pane-header stats / journal. A script must implement its own entry/exit
loop entirely itself (see `smc.pine`'s EXIT loop) and call
`recordTrade()` once per closed trade; the interpreter does no position
tracking of its own. This is meaningfully smaller than TradingView's
`strategy()` model (no automatic position sizing, no equity curve, no
built-in commission/slippage, no concurrent-position handling).

**PARTIAL / PLANNED** — see Phase 3 (generalize the engine) and Phase 4
(real `strategy()` semantics).

## Current market-data provider layer

`backend/app/marketdata/` (~800 LOC): `provider.py` (abstract interface),
`providers/fxcm.py` + `providers/oanda.py` (concrete implementations),
`service.py` (`MarketDataService` — incremental sync via `_missing_ranges`,
only fetching genuinely-missing sub-ranges), `repository.py` (its own
tables: `instruments`, `data_sources`, `market_candles`, `data_sync_jobs`),
`validation.py` (candle validation with `VALID`/`WARNING`/`INVALID`
levels), `timeframes.py` (aggregation up from a `BASE_TIMEFRAME`),
`symbols.py`, `config.py` (env-driven provider selection —
`MARKET_DATA_PROVIDER`, never a provider-specific env var read outside this
module).

Reachable via `sync_market_data.py` (manual CLI,
`python sync_market_data.py EURUSD 2026-07-01 2026-08-01`) **and**, as of
Phase 2, two live FastAPI routes in `app/main.py`:

- `GET /api/marketdata/status` — `{provider, configured, error}`, mirroring
  `/api/telegram/status`'s pattern. Never throws; a missing/misconfigured
  provider is a normal, reportable state.
- `GET /api/marketdata/candles?symbol&timeframe&start&end` — calls
  `MarketDataService.get_candles()` (the same incremental-sync path
  `sync_market_data.py` already used), returning provider-synced OHLC bars.
  404 on an unsupported symbol, 400 on an invalid timeframe/range, 503 if
  the configured provider is missing credentials, 502 on a provider/network
  failure.

Both routes are strictly additive: they read/write only
`market_candles`/`instruments`/`data_sync_jobs` (via `marketdata/repository.py`),
never the `candles`/`symbols` tables `build_db.py` produces, and
`/api/dataset`'s response shape and behavior are unchanged. The frontend
reaches these through `DataLayer.ts`'s `getProviderStatus()` /
`getProviderCandles()` (additive interface methods; `StaticJsonDataLayer`
rejects them with a clear "not available in static mode" error), consumed
today by `StatusBar.tsx`'s provider indicator + manual per-symbol sync
action — a deliberately small, opt-in consumer, not a change to
`ChartPane`'s primary (`getSymbolData`/`/api/dataset`) data path.

**File split (fixed 2026-08-26, see `ROADMAP.md`'s Phase 2 fix decision).**
`marketdata/repository.py`'s tables live in a separate DuckDB file,
`terminal/backend/runtime.duckdb` (gitignored, request-path-writable — see
`app/runtime_db.py`), not in `data.duckdb`. This fixes a confirmed
regression: `app/db.py`'s process-wide, cached `read_only=True` singleton
against `data.duckdb` and a read-write connection to that *same* file path
cannot coexist in one process (DuckDB raises `ConnectionException: ...
different configuration...` — see `tests/test_rw_ro_coexistence.py`), which
previously made every `/api/marketdata/candles` call fail with a misleading
502 once any `data.duckdb`-backed route had run in that process.
`runtime_db.get_rw_connection()` opens a fresh, uncached connection to
`runtime.duckdb` per call (never a cached singleton, so other
independent-process writers — `sync_market_data.py`, `build_db.py`, pytest —
keep working). `data.duckdb` stays read-only at request time, forever,
with zero diff to `db.py`/`main.py`. See
`tests/test_ro_rw_file_separation.py` for the regression test proving both
`GET /api/dataset` and `GET /api/marketdata/candles` now succeed in the same
process.

**PARTIAL → CONNECTED (Phase 2).** Real-broker verification (an actual
OANDA/FXCM account, not the mocked provider the test suite uses) is still
outstanding — see the Phase 2 section of `ROADMAP.md`.

## Current persistence model

| Data | Where it lives today | Durability |
|---|---|---|
| Candles + DB-precomputed SMC events + the one hardcoded backtest's trades/stats | `data.duckdb` (backend, git-LFS) | Durable, server-side, but rebuilt destructively by `build_db.py` |
| Provider-synced candles (FXCM/OANDA) | `runtime.duckdb`'s `market_candles` etc. tables, via `marketdata/repository.py` (a separate DuckDB file from `data.duckdb`, see "Current market-data provider layer") | Durable, server-side, request-path-writable; readable via `GET /api/marketdata/candles` (Phase 2), still a separate dataset from `/api/dataset`'s `candles` table |
| Journal entries | browser `localStorage` (`journalStore.ts`) | Survives reloads, **not** a browser reset/reinstall, not shared across devices |
| Drawings | browser `localStorage` (`drawingStore.ts`) | Same as journal |
| Market-structure ground-truth dataset | browser `localStorage` (`marketStructureStore.ts`) + manual JSON export | Same as journal, with a manual export escape hatch |
| Pine indicator results | IndexedDB (`pineIndexedDbCache.ts`), 12-entry LRU | Performance cache only, not meant as a data store |
| Telegram trade-review answers | server-side, local-only (not on Vercel) | Durable locally, absent in the deployed environment |

**Everything a trader would consider "their data" (journal, drawings,
ground-truth) is currently browser-local only.** This is workable for
today's genuinely single-user/single-machine usage but is a named risk for
Phase 5 to resolve before the evaluation system (Phase 6) depends on any of
it being durable.

## Current deployment model

Single Vercel project via Vercel's Services feature (`terminal/vercel.json`):
Vite frontend + FastAPI backend deploy together, sharing one domain,
`/api/*` routed internally to the backend. `backend/fetch_db.py` is a
build-time-only workaround for Vercel's checkout not reliably applying the
Git-LFS smudge filter to `data.duckdb` — it parses the LFS pointer's own
`oid`/`size`, downloads the real object from GitHub's public LFS media
endpoint, and verifies byte size + SHA-256 before atomically replacing the
pointer (fails the build on any mismatch rather than leaving a corrupt
file). Backend `requirements.txt` is deliberately minimal (fastapi,
pydantic, duckdb only) to stay under Vercel's function size limit;
everything else (`pandas`, `numpy`, `uvicorn`, `pytest`, `httpx`) lives in
`requirements-dev.txt`, installed locally but never read by Vercel. Full
detail and the exact bundle-size math: `terminal/README.md#deploying-to-vercel`.

Telegram trade review is explicitly **not** wired into the production
deployment (see above). **STABLE as documented** — this is a carefully
tuned setup; changes here need the same rigor the README documents (measure
before changing compression levels, bundle composition, etc.).

## Current testing/build workflow

| Area | Command | Location | Status at last audit |
|---|---|---|---|
| Frontend tests | `npm test` (Vitest) | `terminal/` | 73/73 passing, 6 files |
| Frontend typecheck+build | `npm run build` (`tsc -b && vite build`) | `terminal/` | typecheck clean |
| Frontend lint | `npm run lint` (oxlint) | `terminal/` | — |
| Backend tests | `.venv/Scripts/python.exe -m pytest -q` | `terminal/backend/` | 68/68 passing |

No CI configuration exists in the repository (no `.github/workflows`) —
tests and build are developer-run only. **This should be treated as a gap,
not a decision** — nothing here argues against adding CI, it simply hasn't
been done.

## Stable components — do not rewrite

Extend these; do not replace them without a demonstrated, specific reason:

1. Pine lexer/parser/AST/interpreter core (`src/pine/lexer.ts`,
   `parser.ts`, `ast.ts`, `interpreter.ts`) and its worker/cache
   infrastructure.
2. DuckDB schema + FastAPI read path (`backend/app/db.py`, `main.py`).
3. `DataLayer.ts`'s fetch/cache/dedup/windowing model.
4. Replay engine (`replayStore.ts` and its transport-action model).
5. The Zustand-per-concern state pattern.
6. The generic `DrawingObject`/`DrawingKind` model.
7. The `marketStructure/` event schema — the designated ground-truth
   collection system.
8. The Vercel deployment setup (Services + `fetch_db.py` LFS workaround +
   dependency split) — non-obvious, already debugged against real failures.

## Known architectural risks

1. **Single-strategy, offline-only backtest engine.** The largest gap
   versus a general platform; generalizing it (Phase 3) is architecture
   work, not extension.
2. **Two coexisting, unreconciled market-structure truth sources** — see
   the dedicated section below. A third source (evaluation ground truth,
   Phase 6) must not be added without resolving how it relates to the other
   two.
3. **`localStorage`-only persistence** for journal/drawings/ground-truth
   data — no durability against a browser reset, no cross-device story, and
   the data most central to Phase 6 (evaluation) currently lives here.
4. **Pine interpreter's unbounded per-variable history arrays** — `O(bars)`
   per binding forever; the likely driver of super-linear scaling. Not a
   problem yet at 100k-bar scale, but a real ceiling for more symbols, more
   history, or heavier `strategy()`-style scripts.
5. **RESOLVED (2026-08-26).** Originally: "`data.duckdb` is both a
   checked-in build artifact and a live-sync target" — `build_db.py`
   (`os.remove(DB_PATH)` then `duckdb.connect(...)` fresh) deletes the
   *entire file*, which would have silently discarded any
   `market_candles`/`instruments`/`data_sync_jobs` data synced into that
   same file. This is now moot: as of the Phase 2 regression fix (see
   "Current market-data provider layer" and `ROADMAP.md`'s Phase 2 fix
   decision), `marketdata/repository.py`'s tables live in a separate file,
   `runtime.duckdb`, that `build_db.py` never touches, opens, or knows
   exists. A `build_db.py` rebuild of `data.duckdb` has zero effect on
   provider-synced data — there is no longer a shared-file race to
   document an operational workaround for. `build_db.py` itself remains
   unmodified (out of this fix's scope) and stays a manual, offline,
   developer-run operation exactly as before.
6. **Root-level legacy files** (`engine.py`, `smc_backtest_app.html`,
   duplicate `.pine` files, raw CSVs outside `terminal/`) — not a blocker,
   but a standing source of "which file is real" confusion. Not deleted or
   moved as part of this documentation pass (out of scope by instruction);
   flagged here so a future cleanup pass has a reference point.
7. **No architecture doc previously existed in the repository**, despite
   code comments repeatedly citing one ("architecture doc, Section 04/05/06/09").
   This document is written from the code and the prior audit, not from
   that referenced document, which could not be located anywhere in the
   tree. If it resurfaces, reconcile it against this file rather than
   assuming either is authoritative by default.

## Two market-structure/data pipelines — explicit note

The DB-precomputed SMC events (`structure_engine.py`, baked into
`data.duckdb` at `build_db.py` time) and a loaded Pine script's own
runtime-computed structure (e.g. `smc.pine` recomputing swings/BOS/CHoCH
from the same raw bars inside the interpreter) are **two independent,
never-reconciled computations over the same underlying candles.** The
Analysis Hub toggles the DB-precomputed set; Pine indicator overlays render
whatever the loaded script computes. A user can have both visible,
disagreeing with each other, at the same time — this is a known, currently
accepted state, not a bug. See "Explicit source-of-truth rules" below for
how each is scoped, and do not add a third computed-structure source
(evaluation, Phase 6) without an explicit rule for how it relates to these
two.

## Explicit source-of-truth rules

These are binding conventions for all future work, not just observations.
Where a rule doesn't exist yet, it says so explicitly rather than leaving it
implicit.

**Market data (candles).**
- Source of truth for `/api/dataset` (and everything downstream of it —
  `ChartPane.tsx`, the Pine interpreter, the replay engine, the
  market-structure logger): `data.duckdb`'s `candles` table, populated only
  by `build_db.py` from the root-level CSVs. **Unchanged by Phase 2.**
- **Phase 2 decision (final, not provisional):** the `marketdata/` provider
  layer's `market_candles` table is and remains a *separate, additive*
  dataset, exposed through its own route namespace
  (`GET /api/marketdata/status`, `GET /api/marketdata/candles`) rather than
  superseding or merging with `candles`. `/api/dataset` does not read
  `market_candles`, and `market_candles` is never written by `build_db.py`
  or read by anything in the `candles`-based data flow above. If a future
  phase wants provider data to actually replace or supplement the static
  dataset for specific symbols, that is a new, separately-documented
  decision — not something this phase's routes do implicitly.
- **File-level split (2026-08-26 fix):** `candles` lives in `data.duckdb`
  (read-only at request time); `market_candles` lives in a separate file,
  `runtime.duckdb` (request-path read-write) — two different DuckDB files
  on disk, not just two tables in one file. See "Current market-data
  provider layer" above for why (a read-only singleton and a read-write
  connection cannot share one file path in-process).

**Market structure (swings/BOS/CHoCH/FVG/order blocks/liquidity/volume
imbalance).**
- Two independent, equally valid sources coexist by design: DB-precomputed
  (`structure_engine.py` → `data.duckdb`) and Pine-runtime (whatever script
  is currently loaded). Neither overrides the other; the UI shows both as
  independently toggleable layers (`analysisStore.ts` for the former, Pine
  indicator visibility for the latter).
- Neither of these is "ground truth" in the evaluation sense — both are
  *engine output*, not a human judgment. See "Evaluation ground truth"
  below for the third, distinct category.

**Trades.**
- Source of truth for the one existing backtest: `data.duckdb`'s `trades`
  table (EURUSD 1h only), written once by `build_db.py` via
  `run_backtest()`.
- Source of truth for a Pine script's self-reported trades: whatever the
  script itself passes to `backtest.recordTrade()` at runtime — the
  interpreter does no independent verification of a script's entry/exit
  logic.
- These are two different trade sources with two different trust models
  (one is the app's own deterministic engine; the other is arbitrary
  user-supplied script logic) and must not be merged or conflated into one
  "trades" concept without Phase 3/4 explicitly defining how a
  general-purpose engine's trades relate to Pine-self-reported trades.

**Drawings.**
- Source of truth: `drawingStore.ts`, `localStorage`, one `DrawingObject`
  per user-placed mark. This is inherently user-authored data — no engine
  ever writes to this store.

**Journal data.**
- Source of truth: `journalStore.ts`, `localStorage`, keyed by
  `tradeKey(symbol, entryBar)`. User-authored annotations on engine-produced
  trades; never derived or inferred.

**Evaluation ground truth (Phase 6, not yet built).**
- Designated source of truth: `src/marketStructure/`'s
  `MarketStructureEvent`/`FibonacciEvent` records — i.e., only structure the
  user manually drew and (optionally) classified `valid`/`invalid`/
  `uncertain` counts as ground truth for evaluation purposes.
- Neither DB-precomputed nor Pine-runtime structure may be treated as
  ground truth for evaluating an indicator against — that would be
  evaluating an engine against another engine, not against a trader's
  actual judgment, defeating the purpose of the feature. Phase 6 must
  compare indicator/engine output *against* `marketStructure/` records, not
  fold them together.
