# coding-tasks hillclimb — final report (companion to report.html)

Flow: `.claude/hillclimb/coding-tasks/` · 15 coding tasks × 6 reps, run through
`RunManager` (the same entry as `agent-harness run --tools coding`) in a per-case
sandbox · graded deterministically on the end state (fixture repos' own `npm test` /
file-content checks) · model `deepseek/deepseek-flash` · pricing basis: provider token
counts (zero USD reported by the provider) · **no held-out split — all scores
directional** (15 cases; the full set ran every round).

## Headline

**out_tokens 448.7 → 348.3 (−22.4%, paired 95% CI ±5.5%)** at pass **89/90 → 90/90**
(baseline → winner, round 2). Latency −17.9%, cache-read −15.6%, in-tokens −10.4%,
tool_calls 3.6 → 2.9. This is a cost hillclimb at held quality; the +1 pass is within
noise, not a quality claim.

## Per-round table

| round | change (one line) | pass | out_tokens | Δ vs prev | notes |
|-------|-------------------|------|-----------|-----------|-------|
| 0 | baseline | 89/90 | 448.7 | — | median 4.3 s; brands-20 5/6 |
| 1 | model probe: v4-pro | 129/135 | 384.9 | −14.2% | **rejected** — quality 95.6% (ordering family), latency +57% |
| 2 | rule (4): ban post-write confirmation rounds | **90/90** | **348.3** | **−22.4% vs baseline** | **winner**; file rounds 2.35 → 1.54 |
| 3 | rule (6): closed final contract | 90/90 | 377.0 | +8.2% vs winner | **rejected** — receipts demand resurrected confirmation rounds (30% → 95%) |
| 4 | winner prompt × v4-pro (second-model check) | 80/90 | 307.4 | −17.4% vs v1 | token win transfers; quality reads lower (same ordering family) |

## Applied changes (working tree; commit pending user decision)

- `[TUNE]` `src/config.ts` — `CODING_SYSTEM_PROMPT` rule (4), one sentence appended
  (see `v2/change.patch`): self-reading your own output is not proof; do not open a
  round that re-reads/re-counts/re-prints a file you just wrote; the write result
  already confirms it. **Why:** 70/71 write-bearing file-task runs invented such a
  round — 21.9% of all out tokens, 0/70 corrections, one false-positive (the only
  baseline failure). Removing it cut out_tokens 22.4% with pass held.
- Nothing else is applied. v3's rule (6) change was reverted per its kill-line.

## Failure taxonomy (whole loop)

- All quality losses anywhere in the loop are **file-precision ordering tasks**
  (BMW position; Ruby/Perl in reverse order; December/July) — a genuine capability
  boundary, deterministic-graded. flash loses 1/90 there; v4-pro 4/90→10/90 (probe →
  check) — **if v4-pro ever becomes a production model, re-verify rule (4)'s quality
  impact there** (suggestive of, not proven to be, a causal link: the ban removes a
  check it used at 64%).
- Zero harness/infra failures in 495 runs across 5 passes (`errors.jsonl` absent
  throughout); zero anti-cheat restores fired; retries 0.

## Where to look (lite report links each trace)

- Winner vs baseline, same case: `baseline/traces/sorted-list_rep0.json` vs
  `v2/traces/sorted-list_rep0.json` — the post-write confirmation round disappears;
  the final no longer echoes verification output.
- The v3 collision: `v3/traces/brands-20_rep1.json` (confirmation round back, now
  carrying a "receipt"). The v1/v4 model-gap example: `v4/traces/brands-20_rep2.json`.
- Cross-round scores: `trajectory/scores.tsv`; full record: `narrative.md`,
  `v1..v4/change.md` with predictions, intervals, falsifiers, and outcomes.

## What I'd try next

1. Receipt-free final-answer contract (v3's idea, minus the incentive that backfired;
   ceiling ≈ the 10% margin — borderline).
2. Generation-parameter sweep on flash (`maxTokens` etc. — in scope, untried).
3. Harness-level self-read guard — note: cannot reclaim emitted tokens; revisit only
   if the 28% residual confirmation rate grows.
4. A different goal (quality): needs a harder task family or a larger set with a
   held-out split.
