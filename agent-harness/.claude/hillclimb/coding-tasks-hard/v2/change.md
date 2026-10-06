# v2 — rule (4): scoped, compact, non-expanding constraint checks (src/config.ts)

Round 2 lever: a cost-constrained reformulation of v1's rejected check mandate.

## Cost anatomy of v1 (scripted over all 156 traces; +36,661 out-tokens = +470/run)

| bucket | share |
|---|---|
| verdict-check commands | 32.6% |
| temp-copy shell (`Set-Content`/`Out-File` verification copies) | 27.2% |
| assistant text (narration + verdict-listing finals) | 23.9% |
| other shell (npm test reruns, inspection) | 8.0% |
| rewrite payloads (fix loops) | 6.6% |
| read/edit/ls args | 1.7% |

**Concentration:** the 3 converted runs cost +2,158 total (+27.7/run — inside the
+66/run headroom), while **30 newly-checking non-converting runs burned +31,233
(85%)**. The expensive parts added zero conversions: byte-copies produced a CRLF
false alarm that ate a whole round (acronyms-24 rep1 msgs 7–11); "re-check every
constraint" drove big-words rep1's broken-count loop; "make each check able to fail"
as an upgrade standard invented a constraint the task never had (acronyms-24 rep4:
`endsZ=False` → two damaged rewrites, +1,243 tokens, pass 1→1).

**Conversion mechanism (from the traces):** (i) anticipatory care under a check
obligation — acronyms rep1/rep5 wrote correct content first-shot, confirmed by
`sortedMatches: True` / `ALL_PASS = True` from a single compact command (rep5: +419
total = the cheapest observed conversion, the empirical floor); (ii) fix → re-run
the same falsifiable comparison (big-words rep1: `vowelStart: 2` → fix → count broke
→ restore → `allConsonantInitial=True`; its baseline counterpart failed on an
always-truthy check and a false "Sorted A–Z" claim).

## The change

Scope the obligation to SELF-GENERATED content (not input-derived); floor-not-
upgrade (only if not already checking); one compact in-memory command (no temp
copies); never expand a passing check; fix → re-run that same check. Rule (6)
untouched — no conversion mechanism needs it, and its verdict-listing finals are
part of the assistant-text bucket.

## Predictions (registered before the run)

- conversions: point **+2 of 78** (75 → 77); 80% CI [0, +3].
- out_tokens: point **+32 (664 → 696)**; 80% CI [+2, +59] → absolute **[666, 723] ≤ 730**.
  Basis: acronyms +~1,600 (4 runs × one compact check; r0/r3 pay 0), big-words +~931
  (loop preserved), countries-25 +0 (already checking under the incumbent).
- mechanism: previously-failing rows gain one post-write verdict; the 12
  already-checking in-scope rows keep baseline check size and tool_calls (v1's
  +130/run verbosity premium does not recur).

## Falsifiers (numeric)

- **K1** guardrail: out_tokens mean > 730 → revert.
- **K2 (load-bearing)**: premium on the 12 already-checking in-scope rows > +130/run →
  clause failed; that branch lands ≈ +51/run (715) with CI upper ≈ 754 → breach.
- **K3** scope leak: clean-34 + sections-merge + indexed-18 + totals-18 + table-summary
  combined delta > +1,500 (v1: +27,822) → revert.
- **K4** idiom: in-scope check-command median > 350 chars, or any temp-copy → clause ignored.
- **K5** quality: net conversions ≤ +1 (pass ≤ 76) → lever dead.
- **K6** mechanism: 2 of the 3 was-failing rows finish with zero verdict check → not internalized.

Cross-flow note (unchanged): the prompt is shared with `coding-tasks`, whose
self-generated file tasks fall inside the new scope; the close-out runs the easy
flow once to quantify — the ship decision stays the user's.

Run: `npm run eval:coding -- --flow .claude/hillclimb/coding-tasks-hard --sets evals/coding-hard-v1.json:hard --variant v2 --reps 6`

## Outcome (measured 2026-10-06) — REJECTED (K1/K2/K3 fired)

- pass: **78/78 (100%)** again — both failing tasks fully converted; K5 passes
  (net +3). K6 passes: all 3 was-failing rows carry a compact verdict check, and
  those converted rows are **cheap** (acronyms-24 rep1 197 → 319; rep5 155 → 383;
  big-words rep1 788 → **482** — one check + one fix, no loop).
- **K1 fired: out_tokens 664 → 783 (+18.0%) > 730.** **K2's load-bearing assumption
  failed measurably**: already-checking in-scope rows paid a **+310/run premium**
  (kill-line +130) — the mandate grew their checks despite "never expand a passed
  check". K3 fired too (+5,251 across the five input-derived/transform tasks; far
  below v1's +27,822 — the scope clause worked, but not enough). K4's hard gates
  passed (temp copies 35 → 0; check-command median 318 chars, under the 350 line —
  at the edge).
- Verdict per pre-registration: **reverted.** The lever is now fully characterized:
  the quality win is real and the converted rows are cheap, but the class-wide
  check mandate cannot be held inside the +10% cost envelope — the premium lives in
  the already-checking population. Best quality-first formulation archived here if
  the guardrail is ever renegotiated.
