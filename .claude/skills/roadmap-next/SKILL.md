---
name: roadmap-next
description: The autonomous development orchestrator for this forex backtesting platform. Reads ROADMAP.md + docs/ARCHITECTURE.md + CLAUDE.md, identifies the next unblocked roadmap task, routes it to the right specialist (or a generic ECC orch-* skill), and runs it through plan -> implement -> test -> review -> verify -> fix -> update state -> commit. Interactive and human-observed only, one task per invocation. Use when asked to work the next roadmap item, continue platform development, or "run the orchestrator."
metadata:
  origin: project
---

# Roadmap Orchestrator

This skill is the project state machine described in `CLAUDE.md`. It does
**not** reimplement planning, review, or testing logic — it sequences
existing ECC capabilities and this repo's five specialist agents
(`.claude/agents/`) around `ROADMAP.md` as the durable source of truth.

**Read `CLAUDE.md` in full before running any of the steps below.**
Everything referenced here (the Definition of Done, the §9 triggers, the
specialist routing table, the git/branch conventions) is defined there,
not duplicated in this file — if the two ever disagree, `CLAUDE.md` wins
and this file is stale and should be corrected.

## Operating mode (read this before starting)

- **Default is interactive and human-observed.** This skill runs one task
  and then stops to report; it does not chain into the next task itself.
  Whether it is re-invoked by a human, or by a `ScheduleWakeup`/
  `CronCreate` schedule, is governed entirely by `CLAUDE.md`'s
  "Autonomous-loop boundaries" section — that file is authoritative on
  whether an unattended schedule currently exists and what it's scoped
  to. This skill never creates or modifies that schedule itself; it only
  behaves correctly under either mode.
- **When running unattended** (an active `CLAUDE.md`-recorded exception):
  do not wait indefinitely at a §9 trigger for an answer that may not
  come this tick — record the task as blocked with the specific open
  question, move to a different unblocked task if one exists, and let the
  question surface next time a human is actually present. Never guess the
  answer to proceed.
- **One task at a time, fully verified or explicitly blocked before the
  next one starts.**
- **Never proceed past a §9 trigger without a human answer present in the
  transcript.** Use `AskUserQuestion` or plain text and wait — do not
  guess what the human would say.

## Step 1 — Inspect

Confirm the repo's actual state matches what `ROADMAP.md`/
`docs/ARCHITECTURE.md` claim before trusting either:

- `git status` / recent `git log` to see what's already in flight or
  recently landed (don't re-plan work that's already done).
- For anything log-heavy (a full repo scan, `ecc:repo-scan`), do it in a
  fork so the raw output doesn't pollute this session's context.

## Step 2 — Read state

Read, in full, not skimmed:

1. `CLAUDE.md`
2. `docs/ARCHITECTURE.md`
3. `ROADMAP.md`

## Step 3 — Select the next task

`ROADMAP.md` uses this status vocabulary on each phase's `**Status:**`
line: `Not started`, `In progress`, `Blocked (needs Phase N)`,
`Needs human decision (<reason>)`, `Complete (verified <date>)`.

Select the **first phase without `Complete` status whose `Dependencies`
are all `Complete`** (per that phase's own "Dependencies" line — ROADMAP.md
states ordering is dependency-driven, not strictly sequential, so a later
phase can be eligible before an earlier one). If a phase's status is
`Needs human decision`, it is not eligible for autonomous work — surface
it to the human, but move on to the next eligible phase rather than
blocking the whole session on it.

If more than one phase is eligible, default to the lowest phase number
unless the human has stated a priority. If none are eligible (all blocked
on human decisions or on each other), stop and report that explicitly
rather than inventing work.

## Step 4 — Decompose

Once a phase is selected, decompose its Objective (using that phase's
"Major components affected" and "Verification criteria" as the scope
boundary) into a task list via `ecc:planner` or `ecc:code-architect`.
Write the task list to `TodoWrite` — this is session-local and ephemeral,
not written into `ROADMAP.md`.

## Step 5 — Per task

For the next task in the list:

**a. Route.** Use `CLAUDE.md`'s "Specialist routing" table to pick a
specialist agent by the files the task touches, or fall back to the
orchestrating session itself via `ecc:orch-add-feature` / `orch-fix-defect`
/ `orch-change-feature` / `orch-refine-code` for generic/cross-cutting
work. If the task's plan implies touching a stable component, a schema/API
change, or an ambiguous architectural call, consult `platform-architect`
**first** — it never implements, only recommends.

**b. Plan.** `ecc:plan` (or `ecc:prp-plan` for larger tasks). Check the
plan against `CLAUDE.md`'s §9 list *before* implementing. If it trips a
trigger: stop, present the specific question, and wait for the human's
answer in the transcript. Do not proceed on an assumed answer.

**c. Implement.** The routed specialist (a fresh `Agent` call, briefed with
exactly what it needs — the task, the relevant ROADMAP.md phase section,
any constraint the plan surfaced) or the generic `orch-*` skill.

**d. Test.** Full suites, every task:
```
cd terminal/backend && .venv/Scripts/python.exe -m pytest -q
cd terminal && npm test
cd terminal && npm run build
```

**e. Review.** `ecc:code-review` (auto-selects reviewer agents by touched
file type). For anything touching test files: also run
`ecc:pr-test-analyzer` and `ecc:silent-failure-hunter` specifically to
catch a weakened or deleted test being used to force a pass.

**f. Verify.** Walk `CLAUDE.md`'s full Definition of Done checklist (all 9
items) with real command output in hand — not from memory of step (d).

**g. Fix/retry.** If anything in (d)-(f) fails: bounded at 3 attempts.
Attempt 1: the matching `ecc:*-build-resolver` skill for mechanical
compile/type errors. Attempts 2-3: the responsible specialist re-plans
with the actual failure output fed back in. After 3 failed attempts: stop,
record the task as blocked (see Step 7), and either move to a different
unblocked task or escalate to the human — never loop indefinitely on the
same failure, never delete/weaken the failing test to force green.

**h. Update state.** Only after (f) passes: update `ROADMAP.md`'s
verification-criteria checkboxes (✅ with evidence, ⏳ if still open) and
status line for the phase, and `docs/ARCHITECTURE.md`'s subsystem status
if this task changed one (PARTIAL → STABLE, etc.) or added a
source-of-truth rule.

**i. Commit.** Per `CLAUDE.md`'s git/branch conventions: direct commit to
`master` for low-risk verified work, or a feature branch + `ecc:orch-review`
/ `ecc:pr` for anything that hit a §9 trigger and was approved. One commit
per verified task. Never push without separate explicit approval.

## Step 6 — Report and stop

After the task (whether completed, blocked, or halted on a §9 trigger),
report to the human:

- What was done, with real evidence (test counts, build status, diff
  stat) — never an unverified claim.
- What's still open in the current phase.
- Whether the next task is ready to start, or whether something needs a
  human answer first.

Then **stop**. Do not automatically continue to the next task — that is
what "interactive and human-observed" means. The human re-invokes this
skill (`/roadmap-next` or asking again) when ready for the next task.

## What this skill deliberately does not do

- It does not create, modify, or cancel its own scheduling — whether an
  unattended cadence exists at all is `CLAUDE.md`'s decision (recorded in
  its "Autonomous-loop boundaries" section) and `/loop`'s/`CronCreate`'s
  mechanism, never something this skill sets up on its own initiative.
- It does not reimplement `ecc:code-review`, `ecc:tdd-guide`,
  `ecc:test-coverage`, `ecc:verification-loop`, `ecc:checkpoint`,
  `ecc:planner`, or the `orch-*` family — it calls them.
- It does not decide §9 questions on the human's behalf, ever.
- It does not modify `src/marketStructure/` ground truth under any
  circumstance, regardless of which phase or task is in progress.
