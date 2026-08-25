# CLAUDE.md — Project Constitution

This file is the standing contract every human and agent working in this
repository operates under. Claude Code loads it automatically into every
session here — it is deliberately short on "what the code does" (that's
`docs/ARCHITECTURE.md`) and long on "what nobody may do without asking."

This repo is being developed by an autonomous orchestration loop on top of
ECC (see `.claude/skills/roadmap-next/` and `.claude/agents/`), not by
one-task-at-a-time manual instruction. Correctness and preservation of
existing behavior are more important than roadmap-checkbox velocity. Never
optimize for closing a ROADMAP.md item at the expense of the rules below.

## Reading order before touching anything

1. This file.
2. `docs/ARCHITECTURE.md` — what exists, what's stable, the source-of-truth
   rules.
3. `ROADMAP.md` — what's next and why, per-phase dependencies and
   must-not-change constraints.
4. The relevant specialist brief in `.claude/agents/*.md`, if the task
   routes to one (see "Specialist routing" below).

## Stable components — extend, never rewrite

Full detail and rationale: `docs/ARCHITECTURE.md`'s "Stable components"
section. Summary:

1. Pine lexer/parser/AST/interpreter core and its worker/cache
   infrastructure.
2. DuckDB schema + FastAPI read path (`backend/app/db.py`, `main.py`).
3. `DataLayer.ts`'s fetch/cache/dedup/windowing model.
4. Replay engine (`replayStore.ts` and its transport-action model).
5. The Zustand-per-concern state pattern.
6. The generic `DrawingObject`/`DrawingKind` model.
7. The `marketStructure/` event schema — the designated ground-truth
   collection system.
8. The Vercel deployment setup (Services + `fetch_db.py` LFS workaround +
   dependency split).

## Source-of-truth rules (summary — full text: `docs/ARCHITECTURE.md`)

- **Market data**: `data.duckdb`'s `candles` table (via `build_db.py`) is
  the only thing `/api/dataset` reads. `market_candles` (via
  `/api/marketdata/*`, Phase 2) is a separate, additive dataset — never
  merged into `candles`, never read by `/api/dataset`.
- **Market structure**: DB-precomputed (`structure_engine.py`) and
  Pine-runtime structure are both *engine output*, coexisting,
  independently toggleable. Neither is ground truth.
- **Ground truth (Phase 6+)**: only `src/marketStructure/`'s
  `MarketStructureEvent`/`FibonacciEvent` records. Read-only to every
  engine/backtest/evaluation component, forever. Never inferred, never
  synthesized, never adjusted to make a hypothesis look better.
- **Trades**: `data.duckdb`'s `trades` table (EURUSD 1h, `run_backtest()`)
  and a Pine script's self-reported `backtest.recordTrade()` calls are two
  different trust models — never merged without an explicit Phase 3/4
  decision.

## Definition of Done — every task, no exceptions

1. Full backend suite passes: `.venv/Scripts/python.exe -m pytest -q` from
   `terminal/backend/` — the *whole* suite, not just new tests.
2. Full frontend suite passes: `npm test` from `terminal/`.
3. `npm run build` (`tsc -b && vite build`) clean, from `terminal/`.
4. New tests exist for new behavior (verify with `ecc:pr-test-analyzer` or
   `ecc:test-coverage` — coverage existing is not the same as coverage
   meaningful).
5. `git status` / `git diff --stat` reviewed — only intended files changed.
6. Code review pass (`ecc:code-review`) with zero blocking findings.
7. If a stable component (above) was touched: explicit regression
   evidence — byte-identical output, or an explicitly documented and
   human-approved difference. This is not optional; it's the same
   discipline already used for the Pine interpreter's perf work.
8. The current ROADMAP.md phase's verification-criteria lines re-checked
   against what was *actually just verified in this session* — mark ✅
   only with real command output in hand, ⏳ otherwise. Never mark a
   ROADMAP.md item done from memory or assumption.
9. Human approval obtained if the task hit a §9 trigger below.

Never delete, skip, or weaken a test to make a suite pass — that is a
blocking code-review finding, not a fix. Never report a test/build result
that wasn't actually just produced by running the command.

## §9 — Stop and ask the human before proceeding

Check these *before* implementation starts, not just before commit:

- Any DB schema change beyond purely additive `CREATE TABLE IF NOT EXISTS`
  (new/altered/dropped tables or columns on existing tables).
- Any change to `/api/dataset`, `/api/symbols`, `/api/quotes`, or any
  other existing public API response shape.
- Any Pine language-semantics change (lexer/parser/AST/stdlib behavior)
  beyond additive new functions.
- Any change that would alter the existing EURUSD 1h backtest's
  trades/stats output.
- Any write path touching `src/marketStructure/` ground truth, from
  anything other than the human-facing recording UI.
- Deleting or rewriting anything on the stable-components list above.
- Adding, removing, or upgrading a dependency.
- Any destructive or shared-state git operation (force-push, history
  rewrite, `--no-verify`, or pushing at all — pushing already requires
  explicit approval as a standing rule regardless of this file).
- Ambiguous roadmap requirements or a genuine product/trading-logic
  judgment call (e.g. Phase 6's match tolerance for a BOS event).
- A task exhausting its 3-attempt retry budget (see below).
- Anything requiring real external credentials or a live-account network
  call (an actual OANDA/FXCM account, even a practice one).

## Git / branch conventions

- **Low-risk, additive, fully verified work**: commit directly to
  `master`, matching current repo convention. One commit per verified
  task. Conventional-Commit-style prefix matching the existing log
  (`feat:`/`fix:`/`perf:`/`docs:`/`test:`). Commit body references the
  ROADMAP.md phase/task it advances. `Co-Authored-By` trailer per the
  standing git protocol.
- **Work that hit a §9 trigger and was approved**: a feature branch,
  reviewed via `ecc:orch-review` / `ecc:pr` before merge. Never merge a
  §9-triggered change without that review pass.
- Never `--no-verify`, never amend a previous commit (always a new one),
  never force-push, never push without explicit approval in the
  conversation — these are standing rules independent of this file.

## Testing & verification commands (exact — don't guess)

```
backend:          cd terminal/backend && .venv/Scripts/python.exe -m pytest -q
frontend:         cd terminal && npm test
typecheck+build:  cd terminal && npm run build
```

## Autonomous-loop boundaries

- **Default posture is still interactive-only**: a human runs
  `.claude/skills/roadmap-next` and watches, and can interrupt at any
  point. No `ScheduleWakeup`- or `CronCreate`-based unattended run should
  be created without a separate, explicit human request — this default
  has not changed.
- **Explicit exception, in effect since 2026-08-26**: the human explicitly
  requested (`/loop 30m /roadmap-next`), after being shown the tradeoff
  and confirming it reverses the interactive-only default, a recurring
  cron schedule (`*/30 * * * *`, created via `CronCreate`, subject to the
  platform's 7-day auto-expiry) that re-invokes `/roadmap-next`
  unattended. This exception is scoped to that specific schedule; it does
  not authorize any *other* unattended automation without its own
  separate, explicit request. Cancel with `CronDelete` (job ID recorded
  wherever it was created) to return to the interactive-only default.
- **Because the loop can now run with no one watching a given tick**: if a
  §9 trigger fires while unattended, the orchestrator must not wait
  indefinitely for an answer that may not come — record the task as
  blocked (with the specific question that needed asking) and move on to
  a different unblocked task, exactly as it would for an exhausted retry
  budget. It surfaces the open question the next time a human is actually
  present, rather than stalling the whole loop on it.
- **Pushing to a shared branch always requires separate, explicit
  human approval in the transcript, with no exception** — this is
  unaffected by the scheduling exception above. An unattended tick may
  commit locally; it must never push.
- One task fully verified and committed (or explicitly recorded as
  blocked) before the next task starts — never parallel uncommitted work
  across tasks.
- Bounded retries: 3 attempts per task on failure, then stop and report.
  Never loop indefinitely on the same failure.
- Never proceed past a §9 trigger without a human answer present in the
  transcript, except as modified by the "because the loop can now run
  with no one watching" rule above.

## Specialist routing

Project-specific agents exist only where no generic ECC skill/agent has
domain knowledge of this repo. Route by the files a task touches:

| Path / concern | Agent |
|---|---|
| `terminal/src/pine/**`, `*.pine` files, `interpreter.test.ts`, `compiler.test.ts` | `pine-specialist` |
| `backend/app/structure_engine.py`, backtest/strategy logic, future `src/evaluation/**` | `backtest-trading-specialist` |
| `backend/app/marketdata/**`, `sync_market_data.py`, `/api/marketdata/*`, `DataLayer.ts`'s provider methods | `market-data-specialist` |
| `terminal/src/components/**`, `DataLayer.ts` (non-provider), `*Store.ts`, `src/drawing/**`, `src/replay/**` | `frontend-platform-specialist` |
| A plan implies touching a stable component, a schema/API/semantics change, or an ambiguous architectural call | `platform-architect` (recommendation only — never implements; human still decides) |
| Cross-cutting or none of the above | the orchestrating session directly, via `ecc:orch-add-feature` / `orch-fix-defect` / `orch-change-feature` / `orch-refine-code` |

## Reuse before you build

Before writing new agent/skill logic for *anything*, check whether an
existing ECC capability already does it. In particular, this project
relies on (not reimplements):

- `ecc:code-review`, `ecc:code-reviewer`, `ecc:python-reviewer`,
  `ecc:fastapi-reviewer`, `ecc:react-reviewer`, `ecc:typescript-reviewer`,
  `ecc:database-reviewer` — code review.
- `ecc:tdd-guide`, `ecc:test-coverage`, `ecc:pr-test-analyzer`,
  `ecc:silent-failure-hunter` — test quality and gap detection.
- `ecc:verification-loop`, `ecc:checkpoint` — build/type/lint/test/diff
  gating and checkpointing (this repo's Definition of Done above adds
  project-specific items on top; it does not replace these).
- `ecc:planner`, `ecc:code-architect`, `ecc:architect` — planning and
  architecture analysis.
- `ecc:orch-add-feature`, `ecc:orch-fix-defect`, `ecc:orch-change-feature`,
  `ecc:orch-refine-code`, `ecc:orch-review` — the plan → TDD → implement →
  review → gated-commit engine for generic/cross-cutting work.
- `ecc:*-build-resolver` skills — mechanical compile/type-error fixes
  during retry.

Project-specific components exist only for domain knowledge no generic
ECC capability has: Pine language semantics, this repo's SMC/fib-OTE
trading logic, the market-data provider abstraction, and (from Phase 6
onward) ground-truth evaluation. See `.claude/agents/` and
`.claude/skills/roadmap-next/`.
