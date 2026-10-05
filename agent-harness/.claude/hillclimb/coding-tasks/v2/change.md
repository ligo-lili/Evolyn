# v2 — rule (4): forbid post-write confirmation rounds (system prompt, src/config.ts)

Round 2 lever: **system-prompt behavior** on the frozen model (deepseek-flash).
Hypothesis (one): the model reads rule (4) "After changing code, PROVE it: run the
project's tests …" as requiring a shell round after ANY authored mutation. On file
tasks there is no test suite, so it invents a content-echo round (`Get-Content
<myfile>` + count/sort checks) — a pure extra round with no corrective value. Fix at
the root: rule (4) must define reading your own output back as not-proof and forbid
the round explicitly.

## Evidence (round-0 census over all 90 baseline traces)

- Out-token split/run: tool-call arguments 52.9%, final answers 31.9%, narration 15.2%.
- **70 of 71 write-bearing file-task runs open a post-write confirmation round**
  (median 137 tok/round) = ~8,855 tok = **21.9% of ALL out tokens**; **0/70 produced a
  correction** (the one genuine self-fix — langs-compound_rep1 "XQuery" — happened in
  a second *write* before any tool result). The only failure (brands-20_rep2) shows the
  round is even misleading: `sorted_ok: True` printed while "BMW" broke the order.
- Engagement census: "never commit"/"never edit test files"/"batch one edit call" obey
  100% (0 violations in 90 runs) — explicit prohibitions in this prompt are effective
  on this model; "Be concise in your final answer" is partially ignored (final median
  266 chars; bug-fix 561) — *not* the lever (already present + tradeoff), only reported.
- Bug-fix flows (npm test proof) are already minimal — untouched by this change.

Quoted traces: `baseline/traces/sorted-list_rep5.json`, `brands-20_rep1.json`,
`brands-20_rep2.json` (failure), `langs-compound_rep1.json`, `string-utils_rep0.json`
(control). Full quotes in the round record (`narrative.md` / analyzer hand-back).

## Predictions (registered before the run)

- Mechanism: post-write confirmation rounds disappear → `tool_calls` mean 3.56 → ~2.7
  (file tasks 2.3 → ~1.3); out_tokens falls via the round's args + narration + finals
  no longer echoing verification output.
- out_tokens: **point −16%** (448.7 → ~377); **80% interval [−21%, −11%]** — lower
  bound above the 10% adoption margin, far outside the ±4.3% floor.
- Tradeoff (reported, not gated): median final-answer 266 → ~245 chars (file tasks
  237 → ~205; bug-fix unchanged) — the echo of self-verification results disappears.

## Falsifiers

- Re-run and count file-task write-runs still opening a post-write round: if ≥ 50%
  (≥35 of 71) still do it, the rule was not internalized and the gain is <8% — lever
  dead at margin; say so.
- pass < 89/90-equivalent band (97.8%) with new file-content or bug-fix failures →
  the prohibition removed real self-verification — revert.

Run command: `npm run eval:coding -- --variant v2 --reps 6` (model: deepseek-flash default).
Patch: `change.patch` (single hunk, src/config.ts). Snapshot: `prompt.txt`.

## Outcome (measured 2026-10-05) — ADOPTED

- pass: **90/90 (100%)** — in band; brands-20 went 5/6 → 6/6 (within noise, but no
  regression anywhere).
- out_tokens: **−22.4%** (448.7 → 348.3; paired CI ±5.5%) — *slightly beyond the
  registered 80% interval's optimistic edge [−21%]*; next round's intervals widened
  per discipline.
- Mechanism confirmed: tool_calls −19.4% overall; file tasks 2.35 → 1.54 rounds;
  bug-fix unchanged (8.39 → 8.17, as predicted). Falsifier detector: post-write
  confirmation rounds present in 71/71 baseline write-runs → **20/66 (30%)** in v2,
  below the 50% kill-line.
- Side effects (all favourable): latency −17.9% (4.9 → 4.1 s), cache-read −15.6%,
  in_tokens −10.4%. Tradeoff as registered: final-answer median 266 → 238 chars.
- Verdict: all three adoption gates passed → **v2 is the incumbent**.
