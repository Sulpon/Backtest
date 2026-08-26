# Terminal

React/TypeScript charting terminal (Vite) with a FastAPI + DuckDB backend
(`backend/`). See `backend/README.md` for the backend's own setup, schema,
and data-rebuild instructions.

## Local development

```
npm install
npm run dev          # frontend, http://localhost:5173
```

In a second terminal, from `backend/` (first-time setup in `backend/README.md`):

```
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload
```

The frontend defaults to `VITE_API_BASE=http://localhost:8000` (see
`.env.example`) - no `.env.local` needed unless you're running the backend
on a different port.

### Cloning this repo (Git LFS)

`backend/data.duckdb` is tracked with [Git LFS](https://git-lfs.com/), not
committed as a normal blob (see `.gitattributes` at the repo root) - keeps
it out of plain git's object history while still being exactly the file
`db.py` reads. A plain `git clone` still works, but you need Git LFS
installed once per machine for the real file to come down instead of a
small pointer:

```
git lfs install          # one-time per machine
git clone <repo-url>
# or, if you already cloned before installing Git LFS:
git lfs pull
```

Without this, `backend/data.duckdb` will just be a ~130-byte pointer file
and `db.py` will fail to open it as a database.

## Deploying to Vercel

This repo deploys as **one Vercel project** using Vercel's
[Services](https://vercel.com/docs/services) feature (`vercel.json`'s
`services` key): the Vite frontend and the FastAPI backend build and deploy
together, sharing one domain, with `/api/*` routed internally to the
backend and everything else served as the static frontend build.

**Project setup on Vercel:**

- **Root Directory**: `terminal` (this directory - the one containing this
  README, `package.json`, and `vercel.json`)
- Build command / output directory: not set in the dashboard - both are
  defined per-service in `vercel.json` (`npm run build` / `dist` for the
  frontend; the backend's `installCommand` runs `pip install -r
  requirements.txt` then `python fetch_db.py` - see below) and take
  precedence.
- Everything else (routing `/api/*` to the backend, the Python entrypoint
  `app.main:app`) is already configured in `vercel.json` - no dashboard
  routing config needed.

**Environment variables to set in the Vercel dashboard:**

| Variable | Where | Value |
| --- | --- | --- |
| `VITE_API_BASE` | Project (used at build time) | Empty string. With frontend and backend on the same domain, the app should call relative paths like `/api/symbols`, not an absolute URL. |
| `CORS_ALLOWED_ORIGINS` | Backend service (optional) | Leave unset. Only needed if the backend is ever split into its own project on a different origin (see below) - same-origin requests never hit CORS at all. |
| `MARKET_DATA_PROVIDER`, `FXCM_ACCESS_TOKEN` / `OANDA_API_KEY` etc. | Backend service (optional) | Only needed if you run `sync_market_data.py`, or use the `/api/marketdata/*` routes, in a context that has these set - `/api/symbols`/`/api/dataset` never call a market-data provider at request time, they only read `data.duckdb`. `/api/marketdata/*` calls the provider and writes to a separate `runtime.duckdb` file (never `data.duckdb`) - see `backend/README.md` and `docs/ARCHITECTURE.md`. Never set these as `VITE_`-prefixed variables - that would ship them to the browser. |

**Data file (`data.duckdb`) - how it actually gets to the deployed backend:**
the backend serves data by reading `backend/data.duckdb` (read-only, ~55MB,
all 3 instruments - see `backend/app/db.py`) at exactly the same local path
it's always used; `db.py` was never changed for Vercel. The file is
committed via **Git LFS** (see [Cloning this repo](#cloning-this-repo-git-lfs)
above), not as a plain ~55MB blob, to keep it out of normal git history.

Enabling Git LFS Support in the Vercel project's Git settings **is not
enough on its own** - confirmed on this project's own deployment, with LFS
Support already on, Vercel's checkout still handed the Python function the
raw ~130-byte pointer file instead of the real database (`duckdb.connect()`
then fails with `IO Error: ... exists, but it is not a valid DuckDB
database file!`). This isn't a one-off misconfiguration; it's a long-standing,
undocumented gap in how Vercel's build checkout applies the LFS smudge
filter, reported against Vercel going back to 2023 with no official fix
([vercel/next.js#58352](https://github.com/vercel/next.js/discussions/58352)).
Leave LFS Support enabled (harmless, and it's what makes local clones and
`git lfs pull` work), but don't rely on it alone for the deployed database.

**`backend/fetch_db.py`** works around this: `vercel.json`'s backend
`installCommand` runs it right after `pip install`. It reads whatever
Vercel's checkout put at `data.duckdb` - if that's already the real file
(e.g. if Vercel's LFS handling is ever fixed), it's a no-op. If it's a Git
LFS pointer, it parses the pointer's own `oid`/`size` fields (never
hardcoded, so this keeps working if `data.duckdb` is ever rebuilt and
recommitted), downloads the real object from GitHub's public LFS media
endpoint (`https://media.githubusercontent.com/media/<owner>/<repo>/<ref>/terminal/backend/data.duckdb`
- verified serving the real file directly over plain HTTPS, no LFS protocol
needed), and only after checking the download's exact byte size **and**
SHA-256 against what the pointer declared does it atomically replace the
pointer with it. Any mismatch, or a failed download, **fails the build**
and removes the partial download - it never leaves a corrupt or
partially-written `data.duckdb` behind.

`<owner>`/`<repo>`/`<ref>` come from Vercel's `VERCEL_GIT_REPO_OWNER` /
`VERCEL_GIT_REPO_SLUG` / `VERCEL_GIT_COMMIT_SHA` build-time environment
variables when available (`ref` deliberately uses the exact deployed
commit SHA, not a branch name, so the fetched database always matches the
exact revision being deployed) - these require "Enable access to System
Environment Variables" under Project Settings -> Environment Variables. If
that's off, or building outside Vercel, the script falls back to hardcoded
`Sulpon`/`Backtest`/`master`, clearly logged either way.

`fetch_db.py` itself never ships in the deployed function - it's build-time
only, listed in `vercel.json`'s `excludeFiles` alongside the other
dev/offline scripts.

**Other things worth knowing:**

- **Services requires plan permissions.** If `services` isn't available on
  your Vercel plan/account, deploy as two separate Vercel projects instead:
  one rooted at `terminal` (frontend only - Vercel auto-detects Vite) and
  one rooted at `terminal/backend` (backend only - Vercel auto-detects
  FastAPI via `app/main.py`, no `vercel.json` needed there at all). In that
  case set `VITE_API_BASE` to the backend project's full URL instead of an
  empty string, and set `CORS_ALLOWED_ORIGINS` on the backend to the
  frontend project's URL, since the two are now genuinely cross-origin.
- **Bundle size.** A first deploy attempt actually hit this: with
  `pandas`/`numpy`/`pytest`/`uvicorn[standard]`/`httpx` all in
  `requirements.txt`, the bundle measured **247.53MB against this
  project's 225MB function size limit** (with only the ~130-byte Git LFS
  pointer standing in for `data.duckdb` at the time - the real 55MB file
  would have pushed it further over). None of those packages are imported
  by the live API (`app/main.py` only uses `fastapi`, `pydantic`, and
  `duckdb`) - they're for the offline sync/build scripts and local dev
  server. Fixed by splitting them into `backend/requirements-dev.txt`
  (installed locally alongside `requirements.txt`, never read by Vercel).
  `vercel.json`'s backend `installCommand` is back (needed to chain
  `fetch_db.py` after `pip install` - see above), which forgoes some of
  Vercel's automatic bundle-size optimization for a custom install command,
  but the dependency trim alone leaves enough margin that this shouldn't
  matter: measured real (uncompressed) package sizes put the trimmed
  dependency set at ~68MB (down from ~194MB for the original 8 packages),
  so estimated final size is ~247.53MB − ~126MB (removed packages) +
  ~52.76MB (real `data.duckdb` instead of the pointer) ≈ **174MB**, against
  the 225MB limit. `vercel.json` also excludes `tests/`,
  `.pytest_cache/`, `.venv/`, and the offline scripts/config files from the
  bundle, though those are small - the dependency split is what actually
  mattered.
- **All backend routes are already prefixed with `/api/`** - exactly what
  the `vercel.json` rewrite matches, so no route changes were needed as
  more were added (`/api/quotes`, `/api/telegram/*`).

## Telegram Trade Review

Sends a trade (chart snapshot + entry/SL/TP/setup) to Telegram with
YES/NO/PARTIALLY buttons, and saves your answer back against that trade -
a strategy-validation log, not just a notification. **Local/self-hosted
only for now**: review answers need to persist server-side, and Vercel's
serverless filesystem doesn't persist between invocations (`data.duckdb`
itself is fetched fresh at *build* time for exactly this reason - see
`backend/fetch_db.py`) - so this feature isn't wired into the production
deployment yet. Everything below applies to running `backend/app/main.py`
locally.

Milestones (in progress - see commit history / recent work for current
status):
1. Telegram connection + configuration + a "Test Telegram" button (Settings
   → Telegram tab).
2. Send a real existing trade's data to Telegram.
3. Generate a chart snapshot from the actual platform chart
   (`chart.takeScreenshot()`, compositing the Pine indicator overlay canvas
   on top where present - see `PineIndicatorLayer.tsx`).
4. Send snapshot + trade info + YES/NO/PARTIALLY inline buttons.
5. Handle the Telegram callback and save the answer.
6. Show review status in the trade journal.
7. Optional rejection/partial reasons.
8. Retry/error handling, idempotency.

**Setup** (Milestone 1): copy `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` from
`backend/.env.example` into `backend/.env` (instructions for getting both
from @BotFather are in that file), restart the backend, then use Settings
→ Telegram → Test Telegram in the app. There is no in-app field for the
token itself - it's server-side only (`app/telegram/service.py`), never
sent to or stored in the browser. A missing/misconfigured Telegram setup
degrades to "not configured" everywhere - it never breaks any other part
of the app, by design (`TelegramService` methods return a result object
and never raise).

## Performance

Baseline numbers below are all measured against a **production build**
(`npm run build && npm run preview`), not `npm run dev` - React's
development mode carries substantial per-render instrumentation overhead
(prop/state diffing for the component inspector, mainly) that scales with
object size, and this app's own state (100k candles + tens of thousands of
SMC events per symbol/timeframe) is large enough that dev-mode overhead
alone added 700-900ms to a warm symbol/timeframe switch that costs under
50ms in production. Always benchmark this app's own perceived responsiveness
against a production build; dev-server numbers overstate the real cost of
almost everything except the initial page load.

| Operation | Before | After | Notes |
|---|---|---|---|
| Initial load -> usable chart | 2.9s (dev) | ~0.95s (prod) | |
| Symbol switch, cold | 2.2s (dev) | 120-420ms (prod) | |
| Symbol switch, warm (cached) | 1.2s (dev) | 240-290ms (prod) | target <500ms - met |
| Timeframe switch, cold | 2.6s (dev) | 140-460ms (prod) | |
| Timeframe switch, warm (cached) | 1.3s (dev) | 360-430ms (prod) | target <500ms - met |
| Pine indicator, first compute (smc.pine, ~100k bars) | 20.3s | **~19-24s (~4-12%, avg ~6.5%, faster)** | interpreter Phase 1 - see below; output byte-identical, confirmed 4x |
| Pine indicator, in-memory cache hit (toggle visibility) | 166-345ms | 140-375ms | already met target before this pass |
| Pine indicator, persistent cache hit (after a page reload) | 20.3s (always recomputed) | 0.9-1.5s | IndexedDB-backed, see pineIndexedDbCache.ts |

Backend, `/api/dataset?symbol=EURUSD&timeframe=1h` (100k bars + ~36k events, ~12MB raw JSON):

| Stage | Before | After |
|---|---|---|
| DB query (all tables) | ~90ms | unchanged - already fast, not touched |
| `json.dumps` | ~194ms | unchanged |
| gzip compress | level 9, ~1200ms | **level 4, ~110ms** |
| Windowed request (`?limit=3000`, fast-paint path) | n/a - endpoint didn't support this | ~60KB gzipped, <100ms server-side |

Gzip level was chosen from a full level-by-level benchmark on the real payload, not a guess:

| Level | Time | Size (vs raw 12.07MB) |
|---|---|---|
| 1 | 74ms | 2.32MB (19.2%) |
| 4 | 109ms | 1.99MB (16.5%) **- chosen** |
| 6 | 198ms | 1.87MB (15.5%) |
| 9 (previous default) | 1222ms | 1.79MB (14.8%) |

Levels 5-9 buy back only ~1.7 percentage points of size for 11x the CPU
time; 4 is the point past which that trade stops being worth it.

### What changed

1. **Gzip compression level** (`backend/app/main.py`) - `compresslevel=9` -> `4`.
2. **Stale Pine/indicator results eliminated** (`src/pine/usePineIndicators.ts`,
   `src/lib/latestWins.ts`, `src/components/ChartPane.tsx`) - a symbol/
   timeframe switch now clears indicator results and the native stat
   readout immediately rather than leaving the previous symbol's FVG
   boxes/trade count on screen until the new computation finishes. Race
   safety (a slower request landing after a faster, newer one) is handled
   by `LatestWins`, a small generation-counter utility, not by hoping
   React's effect timing happens to be correct.
3. **Windowed data loading** (`backend/app/main.py`'s `limit` param,
   `src/data/DataLayer.ts`, `src/components/ChartPane.tsx`) - the chart
   paints from a fast ~3,000-bar window immediately, while the full
   history (needed by replay, Pine, and market-structure logging) loads
   concurrently in the background and transparently replaces it. Skipped
   entirely when the full dataset is already cached, so a warm revisit
   never pays for the extra request.
4. **Persistent Pine result cache** (`src/pine/pineIndexedDbCache.ts`) -
   computed Pine results survive a page reload, keyed by indicator id,
   script hash, input overrides, start date, symbol, timeframe, and a
   dataset-content fingerprint (never just symbol/timeframe). Bounded to
   12 entries, LRU-evicted.
5. **Request deduplication** (`src/data/DataLayer.ts`) - `listSymbols()`
   and `getQuotes()` now share one in-flight/settled request the same way
   `getSymbolData()` already did, closing the double `/api/quotes` call
   observed on initial load (a React StrictMode dev-mode artifact, but the
   underlying lack of caching was real).

### Pine interpreter - Phase 1 (profiling-driven, low-risk only)

A full CPU-profiling pass (run directly in Node against the real
interpreter and the real 100k-bar EURUSD/1h dataset - see the git history
for the profiling report) found the interpreter's ~20s cost is 100%
interpretation (`run()`); tokenize+parse are <0.2%. Top self-time: `evalExpr`
dispatch 26%, `resolveArgs` 11% (44% incl. descendants), `evalCall` 11%,
`evalBinary` 8%, `Scope.resolve` 7%. Scaling is super-linear (0.127ms/bar
at n=1,000 -> 0.271ms/bar at n=100,000) - heap grows to ~830MB over a full
run, most likely dominated by the ~338 script-level variables each
retaining a full `O(bars)` history array (inherent to supporting Pine's
`[]` arbitrary-offset lookback, not addressed this phase - see "not done"
below).

Four low-risk items were implemented, all verified to produce **byte-
identical output** (`JSON.stringify` equality of the full `PineOutputs` -
not just counts) against the pre-change interpreter, run 4x for
consistency:

1. **`Scope.resolve` caching** (`identCache`, a `WeakMap<node, Binding>`) -
   an Ident/history-ref/Reassign AST node always resolves to the same
   Binding across every bar (Pine scoping here is static: if/for blocks
   share their enclosing scope, and a user function's scope is created
   once and reused for every call). Caches that resolution instead of
   re-walking the scope chain on every read.
2. **`evalCall` dispatch caching** (`callCache`, a
   `WeakMap<node, CallResolution>`) - which function a Call node's callee
   resolves to (user function / `input()` / stdlib global / stdlib
   namespace function) is equally static, EXCEPT method-call sugar
   (`obj.method()`), which depends on the runtime value's own tag and is
   deliberately never cached.
3. **`resolveArgs`/`resolveArgsWithLeadingValue` hidden-class stability** -
   pre-declare every param name (in its fixed order) before evaluating
   arguments, so V8 settles on one stable object shape per stdlib call
   site instead of a shape that varies with whichever args happened to be
   supplied.
4. **Eager line/box/label deletion** (`Interpreter.deleteLine/Box/Label`,
   called from `line.delete()`/`box.delete()`/`label.delete()`/
   `d.delete_line()` in `stdlib.ts`) - a deleted drawing object is now
   actually removed from its registry Map immediately, not just flagged
   `.deleted` and left for the `max_lines_count`/`max_boxes_count`/
   `max_labels_count` FIFO cap to evict eventually. smc.pine sets those
   caps to 1,000,000/500,000/1,000,000 (i.e. effectively no cap), so
   without this the registries grew to 600k+ entries by bar 90,000 despite
   a final output of ~1,300 each.

**Result: ~4-12% faster (avg ~6.5% across 4 trials), output byte-identical
every time.** Below the ~15-25% initially estimated from raw profiling
percentages - profiled self-time doesn't translate 1:1 into realized
speedup once GC/allocation effects (mostly untouched by these 4 items) are
accounted for. Still a real, zero-risk win, banked before considering
anything riskier.

### Deliberately not done (Pine interpreter)

- **The core tree-walking dispatch model is unchanged.** Recompiling the
  AST to closures once (removing the runtime switch-dispatch on
  `expr.kind`/`stmt.kind` for every node, every bar) is the largest
  remaining lever (est. 25-35%+) but is an architectural change, not a
  local optimization - needs its own dedicated, carefully-verified pass.
- **Per-variable history arrays are still unbounded** (`O(bars)` per
  binding, forever) - the most likely driver of the super-linear scaling
  and ~830MB peak heap. Bounding this safely requires either static
  analysis of every `[]` reference in a script to find its real max
  lookback, or a runtime high-water-mark approach - either has real
  wrong-answer risk if done carelessly (silently truncating a lookback a
  script actually needs), so it wasn't attempted this phase.
- **`ta.highest`/`ta.lowest`/etc. still do an O(length) rescan per call.**
  Profiling showed this costs only 0.7% of total time for smc.pine
  specifically (it doesn't lean on large lookback periods), so a sliding-
  window rewrite wasn't worth the risk here - flagged only as a latent
  cost for a future script that does.
- **True infinite-scroll history backfill was not implemented.** The
  `limit` param supports it (it's a real, general "windowed" query, not a
  one-off), but the frontend only uses it for the one-shot fast-paint
  window, not for progressive backfill as the user scrolls back - the
  concurrent full-dataset fetch means the complete history is always
  available within about a second regardless, which was judged to make
  the added complexity (and bar_index re-indexing risk across replay/Pine/
  market-structure logging) not worth it at this data scale (100k bars).

## Stack notes

Vite + React 19 + TypeScript, `oxlint` for linting (see `.oxlintrc.json`). Run tests with `npm test` (vitest).
