# v1 — model probe: deepseek/deepseek-v4-pro (prompt / context / loop unchanged)

Round 1 lever: **model only** (cost-hillclimb search order: model before prompt —
prompt wins do not transfer across models). No file changes; the variant is the run
command's `--model` flag. Revert = re-run with the flash default.

Run command:
`npm run eval:coding -- --variant v1 --model deepseek/deepseek-v4-pro --reps 6`

Predictions (registered before the run):
- pass: **≥88/90 — likely** (v4-pro is the stronger of the two deepseek models in
  the registry).
- out_tokens mean: **80% interval [−30%, +20%]** vs baseline 448.7 — direction
  genuinely unknown: a stronger model may need fewer rounds (fewer model calls,
  less output), but may also narrate more.
- mechanism to watch: tool_calls / rounds per run — fewer rounds ⇒ fewer calls ⇒
  less output.

Falsifiers:
- (a) pass < 88/90 → flash keeps the incumbent; v4-pro is recorded as a
  quality-reference cell only.
- (b) pass holds but out_tokens ≥ +10% → flash keeps the incumbent on the token
  axis; v4-pro stays a candidate base only if a later prompt/context climb on it
  re-opens the gap.

No code diff this round (change.patch intentionally absent). Transcript evidence:
`v1/traces/`. The row's `model` field records the requested spec
`deepseek/deepseek-v4-pro` (pi does not surface the serving id — documented
limitation).

## Outcome (measured 2026-10-05)

- pass: **129/135 at 9 reps (95.6%) — below the 97.8% floor**; all 6 failures are
  ordering-constraint tasks (brands-20 ×2 "BMW" position, langs-compound ×3
  "Ruby"/"Perl" in reverse order, descending-months ×1 "December"). The 3-rep
  extension confirmed the 6-rep read — not draw luck.
- out_tokens: −14.2% (paired CI ±7.9%) — real, but **mechanism ≠ prediction**:
  tool_calls −2.3% (n.s.); the cut came from shorter text (final-answer median
  266 → 191 chars).
- latency_s: +56.6% (CI ±1.8 s) — significant.
- Verdict: falsifier (a) fired → flash keeps the incumbent; v4-pro recorded as a
  quality-reference cell. No promotion.

