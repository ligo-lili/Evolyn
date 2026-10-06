# v1 — rule (4)+(6): verdict-bearing constraint checks for generated output (src/config.ts)

Round 1 lever: system-prompt behavior. Census (scripted over all 78 baseline traces,
18 precision-family runs) shows **perfect separation**: runs with a real ordering
comparison — **14/14 pass**; runs with NO check (2) or an always-truthy check (1) —
**all 3 baseline failures**. Checks caught real defects and drove repairs in ≥4 runs
(countries-25 rep0/1/3; big-words rep3: "draft accidentally included octopus — the
check caught it").

The 3 failures, with evidence:
- `acronyms-24` rep1 — memory write, 1 tool call, adjacent transposition
  (`CDN, CSS, CPU`), final claims "alphabetically sorted" — no check.
- `acronyms-24` rep5 — "SaaS" in an uppercase-only list — no check.
- `big-words` rep1 — its repair edit broke order (`panda` before `pillow`) and its
  unparenthesized PowerShell comparison `[bool]($sorted -join ',' -eq $w -join ',')`
  printed **`is-sorted: True` on the misordered file** (verified always-truthy
  empirically); the final message claimed "Sorted A–Z" — a false-positive
  verification presented as proof.

Hypothesis: failures live in the two branches rule (4) doesn't cover — constrained
output written from memory (proof scoped to "After changing code"; the ban list even
names "re-count"), and checks that cannot fail. Fix: rule (4) requires a
verdict-bearing check over constrained output and draws the seam (verdict checks =
proof; restatement still banned); rule (6) narrows final claims to what checks
reported.

## Predictions (registered before the run)

- pass: point **+2 of 78** (75 → 77, +2.6pp); **80% interval [0, +3] runs**. The
  paired ±3pp view needs ≥2 to separate from noise; +1 would be directional-only.
- out_tokens: point **+15** (664 → ~679, **+2.3%**); 80% interval [+5, +45] — inside
  the +10% guardrail (≤730) even at the high end.
- mechanism: previously-failing acronyms rows show `tool_calls` 1 → ≥2 plus a
  post-write comparison verdict in the trace; the big-words_rep1 false-positive
  pattern (`is-sorted: True` on a misordered file) does not recur.

## Falsifiers / kill-lines

- ≤ 0 net conversions while out_tokens mean ≥ 697 → cost paid, no gain — lever dead.
- Guardrail breach (out_tokens mean > 730) → revert.
- Mechanism kill: ≥ 3 constrained-output runs still finish with zero verdict-bearing
  checks and no net conversion → clause not internalized.

## Cross-flow note

The prompt is shared with `coding-tasks` (whose v2 winner banned post-write
confirmation rounds for cost). This carve-out ("counts / pass-fail flags are proof")
may partially re-open that flow's file tasks; after v1 lands, run the easy flow once
(15×6, ~8 min) to quantify the cross-flow token effect — the prompt ship decision
belongs to the user.

Run: `npm run eval:coding -- --flow .claude/hillclimb/coding-tasks-hard --sets evals/coding-hard-v1.json:hard --variant v1 --reps 6`

## Outcome (measured 2026-10-06) — REJECTED on the cost guardrail

- pass: **78/78 (100%)** — all 3 known failures converted (big-words 5/6 → 6/6,
  acronyms-24 4/6 → 6/6); point +3, at the edge of the registered interval [0, +3].
  Mechanism proven: precision runs with a sort/comparison shell check 24/30 → 30/30;
  the was-failing rows show the predicted pattern (acronyms-24 rep1: tool_calls 1 → 3
  and pass; rep5: 1 → 2 and pass; big-words rep1: 4 → 9 and pass).
- **out_tokens 664 → 1134, +70.8% (paired CI ±238)** — the registered guardrail
  (≤730, +10%) is breached more than sevenfold; latency +49.6%, tool_calls +25.2%.
  The predicted +2.3% missed by ~30×: the mandated check-and-recheck loops are the
  real bill.
- Verdict per pre-registration: **guardrail breach → reverted.** The quality finding
  stands — a verdict-bearing check is present in every converted run — so round 2
  targets a formulation that keeps ≥2 conversions inside the guardrail, or an honest
  "you can't have both" finding.
