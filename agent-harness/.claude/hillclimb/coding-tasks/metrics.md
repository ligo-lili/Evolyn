# coding-tasks metrics

**Target (this hillclimb): `out_tokens`, lower** — API-reported output tokens per run
(all assistant content across the run's turns). This is the cost proxy: deepseek
reports zero USD cost and no verified provider rate card is available, so the
pricing basis is **provider-reported token counts** (input / output / cache-read),
never dollars.

| id | kind | role | notes |
|----|------|------|-------|
| pass | binary | GUARDRAIL | deterministic end-state grading (fixture `npm test` / file-content checks). Band: must stay **≥ 88/90** (baseline 89/90). |
| verified | binary | process metric | write→read-tool read-back; undercounts shell-based verification (baseline 11/90). Not gated. |
| out_tokens | perf | **TARGET (lower)** | paired-delta noise floor ±4.3% (15×6). Adoption margin: **≥10% cut**. |
| in_tokens | perf | watch | non-cached input; noisy (the cache split shifts run to run) — reported, not gated. |
| cache_read | perf | watch | automatic provider caching; large raw share at ~0.1× price. |
| latency_s | perf | watch | wall-clock per run; API-side drift limits round-to-round comparability. |
| tool_calls | perf | mechanism indicator | extra tool rounds are the measured cost driver (cost-hillclimb: ~+1/3 per-case cost per extra round) — every round's predicted mechanism must show up here or in a named field. |
| answer chars (median) | derived | tradeoff report | median final-answer length per variant; brevity is a quality tradeoff to surface, not a free win. |

Split: **none** — 15 cases are too small for a meaningful held-out slice; per-round
scores are **directional** (full set × 6 reps every round keeps rounds comparable).

Baseline: 2026-10-05 · deepseek/deepseek-flash · 15 cases × 6 reps · 89/90 pass ·
out_tokens mean 448.7 · in 1013 · cache-read 11288 · 4.9 s/run · 3.6 tool calls.
