# coding-tasks-hard baseline — narrative

Environment fingerprint: harness_sha `ea7a7904f798` (runner + coding-hard-v1.json +
6 fixtures + grader sources; recorded by --approve-harness at the re-run) · model
`deepseek/deepseek-flash` · node v24.14.0 · working tree: hard-set files uncommitted.

Purpose: the companion flow to `coding-tasks` (98.9% saturated) — **quality headroom**.

| round | change | pass | out toks | in toks | s/run | tools |
|-------|--------|------|----------|---------|-------|-------|
| 0 | baseline (deepseek-flash) | **75/78 (96.2%)** | 664 | 1401 | 7.9 | 5.8 |

## By family

| family | pass | note |
|--------|------|------|
| deep-fix (4 chains) | 24/24 | key drift behind a two-hop chain, pagination off-by-one, swapped clamps via a view layer, leaky reference surfaced in a cached report — all solved first-try |
| iterative-fix (2 two-step repairs) | 12/12 | both defect ladders walked cleanly |
| transform-chain (2) | 12/12 | 15-row arithmetic + tie-break ordering; case-insensitive dedup + numbering |
| **precision-scale (5)** | **27/30** | the only failure mass: big-words 5/6 (pillow order), acronyms-24 4/6 (CSS order ×1; "SaaS" fails uppercase ×1), countries-25 / clean-34 / sections-merge 6/6 |

Failure taxonomy (3/78): all are annotation-discipline misses under scale/compound
constraints — one codepoint-ordering slip, one mixed-case collation slip, one
compliance slip (lowercase in an uppercase-only list). Zero infra failures, zero
retries, zero restores (errors.jsonl absent across both passes).

## Correction record (2026-10-06, pre-freeze)

The first full pass showed `sections-21` at 0/6 — the spot-check of its trace showed
the model's output **satisfied every stated requirement** (8/6/4 correctly sorted),
but the task graded a free-choice list with `expectLinesExact` against one arbitrary
reference (apricot vs blueberry). That was a grader defect, not capability mass
(free-choice prompt × exact grader — the audit's "grader too strict" failure mode).
Fixed by rebuilding the task as **input-determined** (`sections-merge`: three source
files → cleanup/dedupe/per-section ordering, counts derived from the inputs); oracle
re-verified (recomputed expectation == set expectation; reference passes, null
fails); the 6 stale rows/traces were dropped and the task re-run (6/6). All other 12
tasks were re-audited for the same trap: each grades a deterministic function of its
inputs (or the fixture's own test suite) — fair.

## Headroom read

96.2% with three documented, deterministic failure modes — real but thin headroom,
concentrated in `precision-scale` (90% family; `acronyms-24` 4/6 is the single most
sensitive case at n=6). The deep-repair mechanisms, even at this depth, do **not**
dent flash: its residual weakness is annotation discipline, not code repair. A
quality hillclimb on this flow is feasible but would want reps raised on the
precision family (or a harder precision sub-family) to have resolution beyond the
3-failure mass.
