# coding-tasks-compact metrics

| id | kind | role | notes |
|----|------|------|-------|
| pass | binary | **HEADLINE** | deterministic exact-content checks via judgeRun. |
| verified | binary | process metric | write→read-tool read-back; secondary, not gated. |
| in_tokens | perf | **fidelity tax** | compact arm +15% vs control — recovery re-reading after folds. |
| out_tokens / tool_calls / latency_s | perf | watch | out −8%, tools +3%, latency ≈0 at baseline. |

**Arm configuration:** `baseline` variant = compact arm (`--preference-tokens 10240`);
`v1` variant = control arm (`--preference-tokens 1000000`, compaction never fires).
Threshold deviation: 10240 is **test-scaled** (production default 65536) — identical
code path, only the trigger point differs; documented, not hidden.

Split: none (7 cases × 3 reps × 2 arms; directional). Model `deepseek/deepseek-flash`,
auto-approve, no skill injection; harness pinned by the integrity gate
(sha `efe455681461…`).

Baseline 2026-10-06: compact 20/21 vs control 20/21; attribution damage 1/21
(`spec-early-1`); fidelity tax +15% in_tokens.
