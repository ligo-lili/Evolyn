# v1 — control arm: compaction disabled (preferenceTokens = 1,000,000)

Not a change candidate — the attribution control for this flow. The `baseline`
variant runs at `preferenceTokens = 10240` (a test-scaled threshold), where the
two-layer context management fires; this `v1` variant lifts the budget so compaction
never triggers. Any task that fails in the compact arm while passing here is
attributable to compaction, not capability.

Pilot evidence (recall-token rep0, both arms pass):
- decisions (harness trace): compact arm 2×compact + 3×defer + 6×reuse; control arm
  7×reuse, zero compaction.
- fidelity tax already visible: compact arm 28 tool calls / 35.4k in-tokens vs
  control 17 / 10.9k — recovery re-reading even without a failure.

Run: `npm run eval:coding -- --flow .claude/hillclimb/coding-tasks-compact --sets evals/coding-compact-v1.json:compact --variant v1 --preference-tokens 1000000 --reps 3`
