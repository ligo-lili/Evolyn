# coding-tasks-hard metrics

Purpose: **quality headroom** — the companion flow to `coding-tasks` (which is
98.9% saturated for `deepseek/deepseek-flash`). This set's pass rate is expected to
show real failure mass (depth chains, two-step repairs, scale × compound
constraints); the baseline below its ceiling is what makes quality gains measurable.

| id | kind | role | notes |
|----|------|------|-------|
| pass | binary | **HEADLINE** | deterministic end-state grading — fixture `npm test` / file-content checks via judgeRun (test files restored from template before grading). |
| verified | binary | process metric | write→read-tool read-back; undercounts shell-based verification. Not gated. |
| latency_s | perf | watch | wall-clock per run. |
| tool_calls | perf | watch | extra rounds are the measured cost driver in the sibling flow; expected to be high here (deep chains). |
| in_tokens / out_tokens | perf | watch | provider-reported token counts; no USD (provider reports zero cost). |

Split: **none** (13 cases; scores directional — the full set runs every rep).
Protocol: model `deepseek/deepseek-flash`, 6 reps, auto-approve, no skill injection;
eval infrastructure pinned by the harness-integrity gate (sha recorded at first run).

Baseline: 2026-10-06 · deepseek/deepseek-flash · 13 cases × 6 reps · **75/78 = 96.2%**
(all 3 failures in precision-scale: big-words ×1, acronyms-24 ×2) · median 7.9 s/run ·
5.8 tool calls · out 664 tok/run. See narrative.md for the sections-21 grader-defect
correction record.
