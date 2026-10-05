# coding-tasks hillclimb — final narrative

Environment fingerprint: git HEAD `fae2bca` + the working-tree prompt change
(`src/config.ts` rule (4), the winner) · harness_sha `d35030a6a97a` (runner + task
sets + fixtures + grader pinned by the integrity gate) · model `deepseek/deepseek-flash`
· node v24.14.0. Goal: **out_tokens ↓**, hold **pass ≥ 97.8%** · no train/test split
(15 cases — scores **directional**) · 4 rounds + 1 second-model check.

| round | change | pass | out toks | in toks | cache-read | s/run | tools | $/run |
|-------|--------|------|----------|---------|------------|-------|-------|-------|
| 0 | baseline (deepseek-flash) | 89/90 | 449 | 1013 | 11288 | 4.9 | 3.6 | — (token basis) |
| 1 | model probe: v4-pro — REJECTED (quality band) | 129/135 | 385 | 609 | 11891 | 7.7 | 3.5 | — |
| 2 | rule (4): ban post-write confirmation rounds — **ADOPTED (winner)** | **90/90** | **348** | 907 | 9527 | 4.1 | 2.9 | — |
| 3 | rule (6) closed final contract — REJECTED (+8.2% vs winner) | 90/90 | 377 | 979 | 11282 | 4.7 | 3.4 | — |
| 4 | second-model check: winner prompt × v4-pro (informational) | 80/90 | 307 | 595 | — | 7.2 | 2.9 | — |

## Final summary

**Recommended change — [TUNE]:** one sentence added to `CODING_SYSTEM_PROMPT` rule (4)
(src/config.ts): *"Reading your own output back is not proof: never open a round to
re-read, re-count, re-list, or re-print a file you just wrote or edited, and never run
a command whose only output restates content you authored. The write result already
confirms the write — state the outcome and finish."* Quality was already at ceiling, so
this is cost tuning — reasonable to decline, but measured clean. (Full text:
`v2/prompt.txt`; diff: `v2/change.patch`.)

**Versus baseline (directional — no held-out split):** out_tokens **448.7 → 348.3,
−22.4%** (paired 95% CI ±5.5%); pass 89/90 → **90/90** (within noise, no regression);
latency 4.9 → 4.1 s (−17.9%); cache-read −15.6%; in-tokens −10.4%; tool_calls 3.6 →
2.9. Reported tradeoff: final-answer median 266 → 238 chars (no longer echoing
self-verification output). Pricing basis: provider token counts — deepseek reports
zero USD cost, so no dollar figure is quoted.

**Why trust this:** deterministic end-state grading (fixture `npm test` / file-content
checks; no LLM judge to game); the mechanism is measured in the traces, not inferred —
post-write confirmation rounds 71/71 baseline write-runs → 20/66 (30%), file-task
rounds 2.35 → 1.54, bug-fix untouched (as predicted); every round ran the full set ×
6 reps under a pinned protocol (harness_sha `d35030a6a97a`); pre-registered gates and
kill-lines decided every adoption, and the same measurement caught v3's +8.2%
regression from a subtle mechanism — sensitivity demonstrated, not assumed. Caveat:
with 15 cases there is no held-out split; treat the delta as directional.

**What else was tried:** v1 — model probe (v4-pro: cheaper tokens −14%, but 129/135
quality on the ordering-constraint family and +57% latency → rejected as base). v3 —
closed final-answer contract (contract internalized: bug-fix finals 529 → 221 chars,
but rule (6)'s "verification receipt" demand resurrected the confirmation rounds —
30% → 95% of file-task write-runs — and out_tokens ROSE 8.2%; reverted). Census ledger
(`v3/change.md`): narration suppression (12.6% block, carries the diagnosis — rejected),
optional-null args (4.8%), bug-fix `ls` (1.3%), residual confirmations (8.7%,
prompt-saturated) — all sub-margin. v4 — second-model check: the token win transfers
to v4-pro (−17.4%, confirmations 64% → 4%) but quality reads lower (80/90 vs 86/90,
same ordering family); v4-pro sits below the band under both prompts — if it ever
becomes a production model, re-verify rule (4) there.

**What I'd try next:** (1) a receipt-free variant of the final-answer contract
(removes the action incentive v3 exposed; ceiling ≈ the 10% margin — borderline by
construction); (2) generation-parameter sweep on flash (maxTokens etc. — untried);
(3) a harness-level post-write self-read guard (returns the round as a tool error —
cannot reclaim emitted tokens, so revisit only if the residual grows); (4) for quality
headroom (a different goal): a harder task family with real failure mass, or a larger
set that supports a held-out split.
