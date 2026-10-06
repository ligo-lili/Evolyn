# coding-tasks-hard baseline — narrative

Environment fingerprint: harness_sha `ea7a7904f798` (runner + coding-hard-v1.json +
6 fixtures + grader sources; recorded by --approve-harness at the re-run) · model
`deepseek/deepseek-flash` · node v24.14.0 · working tree: hard-set files uncommitted.

Purpose: the companion flow to `coding-tasks` (98.9% saturated) — **quality headroom**.

## Hillclimb plan (2026-10-06)

Goal: **raise pass**, hold out_tokens ≤ +10% (664 → ≤730 — a verification-flavored
fix pays its own round cost; that is its account). Scope: coding system prompt +
tool descriptions; model/params, context policy, harness code and the eval
infrastructure are off-limits (the gate enforces the last). Gates: a round wins
with **≥ +1 net pass converted** and no new failure family; **stop after 2
consecutive rounds with no conversion** (cap 6). No split — 13 cases; all scores
directional. Cadence: a fresh analyzer per round reads the full baseline traces; I
apply, run 13×6 (~10 min), report one headline + status table. Close-out: a
no-change control + winner confirmation run; headline uses the confirmation.

**Round 1 (v1 — verdict-bearing constraint checks):** decisive on both axes and
rejected by its own pre-registered rule. Quality: **78/78 = 100%** — all 3 known
failures converted; the census-separation held (precision runs with a real
comparison check went 24/30 → 30/30; the was-failing rows converted with the
predicted tool_call pattern). Cost: **out_tokens +70.8%** (664 → 1134) — the ≤730
guardrail breached sevenfold (prediction missed by ~30×: the check-and-recheck loops
are the bill). Rule reverted; the incumbent stays round 0. Round 2: a
cost-constrained refinement of the same lever, or the honest "can't have both".

**Round 2 (v2 — scoped, compact, non-expanding checks):** the refinement cut v1's
spillover from +70.8% to +18.0% and made the converted rows themselves cheap
(big-words rep1 788 → 482), but the three registered cost lines fired anyway
(out 783 > 730; the already-checking in-scope rows paid +310/run — the load-bearing
K2 assumption failed; +5,251 scope leak). **REJECTED; reverted.** Conclusion of the
climb: the quality lever is real (a verdict-bearing check is present in 100% of
converted runs) but class-wide check mandates cannot be held inside the +10% cost
envelope — a non-mandatory hint-strength variant is the only untried form, at the
cost of probabilistic conversions. The prompt ships as the pre-climb incumbent;
v2's text is archived in `v2/change.patch` if the guardrail is ever renegotiated.

## Final summary (close-out, 2026-10-06)

**Recommended change:** none — the climb adopted nothing; the prompt ships as the
pre-climb incumbent (the committed rule-(4) confirmation-round ban). Two
mandatory-check formulations each reached 100% quality and each breached the
registered cost envelope.

**Versus baseline (directional):** round 1: +3 passes (75 → 78) at +70.8%
out-tokens; round 2 (scoped/compact): +3 passes at +18.0%. The converted rows
themselves were cheap in round 2 (big-words rep1 788 → 482, one check + one fix);
the unavoidable premium sat in the already-checking population (+310/run — the
registered K2 line was +130).

**Why trust this:** every round ran the full set ×6 under a pinned protocol; the
adoption rules were registered before each run and executed mechanically; the
mechanism was measured at trace level (precision runs with a comparison check
24/30 → 30/30; the was-failing rows' tool-call patterns as predicted); two
independent formulations bound the lever from both directions.

**What else was tried / what I'd try next:** the full cost anatomy (v2/change.md:
85% of v1's spend went to 30 non-converting checking runs); the hint-strength
variant ("suggest, don't mandate") is the only untried form — expected to make
conversions probabilistic; a finer per-run violation metric would buy resolution
before another thin-signal quality attempt; the generation-params sweep remains
untried on either flow. Any future prompt-level change should re-run `coding-tasks`
once to price the shared-prompt cross-flow effect.

| round | change | pass | out toks | in toks | s/run | tools |
|-------|--------|------|----------|---------|-------|-------|
| 0 | baseline (deepseek-flash) | **75/78 (96.2%)** | 664 | 1401 | 7.9 | 5.8 |
| 1 | rule (4)+(6): verdict-bearing checks — **REJECTED (guardrail)** | **78/78** | 1134 | — | 10.0 | 7.3 |
| 2 | rule (4): scoped/compact checks — **REJECTED (K1/K2/K3)** | **78/78** | 783 | — | 7.8 | 6.4 |

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
