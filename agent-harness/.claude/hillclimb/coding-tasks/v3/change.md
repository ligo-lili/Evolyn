# v3 — census round: lever ledger (no change applied; decision pending)

Round 3's analyzer re-censused the v2 world (scripted over all 90 v2 traces; out-token
shares char-scaled, validated r²=0.94). Finding: **no non-tradeoff lever reaches the
≥10% adoption margin.**

| lever | mass | verdict |
|---|---|---|
| rule (6) final contract (files changed + verification result, ≤ ~40 words) | 35.6% block; realistic cut 12–16% | only ≥10% lever — finale-brevity **TRADEOFF** → user decision |
| shell-route residual confirmations (19/69 write-runs, 28%) | 8.7% | prompt-saturated (v2's rule (4) forbids it verbatim); enforcement cannot reclaim emitted attempts → sub-margin |
| narration suppression (no prose between tool calls) | 12.6% block | rejected: bug-fix narration carries the diagnosis; quality risk on the only hard-graded family |
| optional-null args (`offset/limit` nulls, `timeout` fields) | 4.8% | schema/description lever, compliance unproven → sub-margin |
| bug-fix r0 `ls` / extra read round | 1.3% / 2.4% | sub-margin |
| required work (edit payloads 12.0%, write payloads 14.3%, reads 7.9%, `npm test` proof, second test) | ~39%+ | not levers |

Bug-fix anatomy (48.7% of all out tokens): narration 12.3% / tool-args 57.1% /
finals 30.7%; flow uniform (5.4 turns, 8.17 calls); all 18 runs pass on the first
re-test; no run ever needed a third test. Final answers are the largest single block
(35.6% of the whole corpus) and **guardrail-invisible by construction** — grading is
end-state only (fixture `npm test` + file-content checks; finals are never read).

## Decision requested (tradeoff)

**Full contract**: final answer = (a) files changed, one line each; (b) the verification
command with its observed result; nothing else; cap ~40 words.

- Predicted: **point −13%** out_tokens (348.3 → ~303); **80% interval [−22%, −6%]**
  (widened per the round-2 interval miss). Bug-fix final median 529 → ~200 chars.
- Kill-lines: corpus median final shrink <25% (bug-fix stays >397 chars) → contract
  not internalized, lever dead; pass <88/90 → revert; realized delta <10% → not adopted.
- Explicit tradeoff: bug-fix answers stop explaining the bug; file-verification detail
  is lost. Brevity is a tradeoff, never a free win.
- If declined: lever exhausted — stop at v2 and proceed to the final report (Step 5).

## Decision (2026-10-05): tradeoff accepted by the user → contract applied

Rule (6) replaced with the closed contract; single hunk, src/config.ts:

```diff
     "(5) Never `git commit` or `git push` unless the task explicitly asks; never force anything. " +
-    "(6) Be concise in your final answer: what changed, where, and how it was verified.";
+    "(6) Final answer — exactly two parts, ~40 words total: (a) the files changed, one line each (path: one-line change); (b) the verification command and its observed result. No cause/background narrative, no re-listing file contents, no check tables.";
```

Full diff: `change.patch`. Snapshot: `prompt.txt`. Run:
`npm run eval:coding -- --variant v3 --reps 6` (deepseek-flash default; gate unaffected —
config.ts is not in harness_paths).

## Outcome (measured 2026-10-05) — REJECTED

- pass: 90/90 — band held.
- out_tokens: **377.0 vs incumbent v2's 348.3 — +8.2% (a negative cut)**; paired CI
  ±11.3%. Realized delta < 10% → **not adopted** per the registered rule.
- The contract itself internalized: bug-fix final median 529 → 221 chars (well past
  the ≤397 kill-line); corpus median 238 → 197 (17% — the corpus-wide <25% kill-line
  fired at face value only because 72/90 runs were already terse).
- Mechanism — the receipts demand collided with rule (4): rule (6)(b) requires a
  "verification command and observed result", and for file tasks the only available
  receipt is checking the file just written. Post-write confirmation rounds
  **30% → 95%** (20/66 → 62/65); finals mentioning verification 49/90 → 89/90;
  file-task tool_calls 1.54 → 2.21. The +0.67 rounds/run swamped the −36 tok/run
  text saving. Bug-fix (which has a genuine `npm test` receipt) was unaffected.
- Action: rule (6) **reverted** to the v2 text; v2 remains the incumbent. Lesson for
  the record: with this model, action-triggering wording beats text-saving wording —
  a prompt change is only as cheap as the actions it does (not) trigger.
