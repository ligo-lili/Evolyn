# coding-skills metrics

| id | kind | role | notes |
|----|------|------|-------|
| pass | binary | **HEADLINE** | deterministic end-state grading via judgeRun. |
| verified | binary | process metric | write→read-tool read-back; secondary. |
| in_tokens | perf | **skill cost** | +60–70% vs baseline in every skill arm (pointer + skill-body reading). |
| out_tokens / tool_calls / latency_s | perf | watch | +7–29% out on v3; latency +4–17%. |

**Arms** (13 tasks × 6 reps each, `coding-hard-v1`, model `deepseek/deepseek-flash`):
baseline = no skill; v1/v2/v3 = one promoted skill injected via `--skill`
(`fix-failing-node-test-suite`, `powershell-test-fix-loop`,
`write-then-readback-verify` — see narrative.md for the per-arm mapping).
Injection = `<available_skills>` pointer in the system prompt; the model reads the
SKILL.md on demand. The runner seeds each sandbox with the promoted skill files and
rebuilds the in-sandbox index (verified: block present in 78/78 rows of every arm).

Split: none (13 cases; directional). Harness pinned at sha `e6ef2bec53a5` (runner +
set + the three SKILL.md files + grader sources).

Baseline 2026-10-06: baseline 78/78 vs v1 77, v2 77, v3 76 — all deltas inside the
set's own ±4% replays band (hard-flow baseline drew 75/78 same day); no skill shows
a measurable benefit; injection costs +60–70% input tokens.
