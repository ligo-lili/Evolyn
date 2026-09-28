# agent-harness

**A durable, self-improving coding agent — built on [Pi](https://github.com/earendil-works/pi)'s low-level agent runtime, with everything Pi does not provide as a reusable library: run-level durability (checkpoint / crash recovery / resume), a fully queryable and replayable execution trace, a permission & budget layer, and a closed loop that turns an agent's own experience into evaluated, gated skills.**

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 119/119 — every test runs without an API key
```

Requires Node ≥ 22.19 (uses the built-in `node:sqlite`). Models: any of
`deepseek/*`, `qwen/*` (DashScope), `openrouter/*` (full catalog), `openai/*`,
`anthropic/*` — keys from the environment (`DEEPSEEK_API_KEY`,
`DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY`, …).

---

## Why

Pi (pi-agent-core) solves "how does an agent run": the agent loop, tool
execution, streaming, multi-provider access. It is intentionally stateless —
no persistence, no recovery, no audit trail, no memory, no self-improvement.

This project stands **on** that runtime (it does not rewrite it) and builds the
layers a real coding agent needs around it:

| Concern | Pi | agent-harness |
|---|---|---|
| Agent loop / tools / streaming | ✅ | reused |
| Edit / grep / ls / shell tools | ✅ | reused (`--tools coding`) |
| Crash recovery (checkpoint → resume on the same run id) | — | ✅ |
| Trace: JSONL + SQLite dual-write, queryable, replayable, debugger-style | — | ✅ |
| Permissions: capabilities, risk classes, interactive approval, audit log | — | ✅ |
| Runaway guards: turns / tool calls / repeated calls / cost / timeout | — | ✅ |
| Context: rolling summaries + tool-result tidying, append-only transcript | — | ✅ |
| Experience memory: Markdown-authoritative, FTS + local embeddings, write-time reflection | — | ✅ |
| Skill self-evolution: mine patterns from traces → distill → eval-gated promotion | — | ✅ |
| Eval framework: deterministic judging, infra-failure guard, regression baselines | — | ✅ |

**Why not just use Pi's `AgentHarness`?** Because its durability model is its
own — adopting it would mean this project becomes "a config file for someone
else's harness" and the durable-execution layer (the differentiation) would be
someone else's code. The low-level `Agent` is explicitly stateless; building
durability on top of it is the point. Pi's harness source is used as a
reference (checkpoint semantics, tool `replay` markers), never imported.

## The three demos

All commands run from `agent-harness/`. Any working model works; the ones below
assume `DEEPSEEK_API_KEY` is set.

### Demo 1 — crash recovery

Kill the agent mid-edit (fault injection is a first-class flag, not a staged
demo), then resume the **same run** from durable state. The recovered
re-execution goes through the same permission gate and audit log as a live
call.

```powershell
npm run harness -- run "Fix the failing test in repos/demo/app.js" `
  --model deepseek/deepseek-flash --tools coding --yolo `
  --fault mid_tool_execution:edit
# → FAULT INJECTED — killing process (simulated crash)

npm run harness -- resume --yolo --tools coding
# → recovery_action: reexecute → run completed, trace seq continues
```

### Demo 2 — the execution is a database

Every run is a first-class, queryable record — "what happened, why" is a query,
not a memory exercise.

```powershell
npm run harness -- trace list
npm run harness -- trace summary <runId>
npm run harness -- trace replay <runId> --until 43    # state at seq 43 + why
npm run harness -- trace query <runId> --tool edit --errors
```

### Demo 3 — the agent improves itself

Mine recurring patterns from its own traces, distill them into a skill, gate
the skill behind an A/B eval against a no-skill baseline, and let new runs
consume it automatically.

```powershell
npm run harness -- run "<task>" --tools coding --yolo      # ×3 similar tasks
npm run harness -- skill mine                              # patterns from traces
npm run harness -- skill draft <patternId>                 # LLM-distilled SKILL.md
npm run harness -- skill promote <candidateId>             # pi loader verified
npm run harness -- skill baseline evals/coding-fix-v1.json --tools coding --repeats 3
npm run harness -- skill eval evals/coding-fix-v1.json --skill <name> --tools coding --repeats 3 --against-baseline
# → verdict: candidate-wins | baseline-wins | tie (INVALID reports never gate)
```

The eval layer refuses wishful thinking: a skill measured **worse than the
no-skill baseline** is refused at promotion; infrastructure failures (rate
limits, out-of-credit) mark the report **INVALID** so a bogus verdict can
never gate anything; ties are reported as ties.

## Architecture in one screen

```text
Task → RunManager → Pi Agent (loop/tools/streaming) → coding tools
         │              │
         │   dispatch (order = invariant):
         │   reporter → trace(JSONL+SQLite) → checkpoint → limits → fault
         │              │
         │   transformContext (model view only: tidy + rolling compaction)
         │   beforeToolCall (limits → permission gate)
         │
crash → resume: rebuild from trace+checkpoint, resolve pending tool calls
        (rebuild / gated re-execute / synthesize), same run id, seq continues

after the run: distill → experience memory (md + FTS + vectors)
               mine tool patterns → skill candidate → eval gate → promotion
               → <available_skills> injection into future runs
```

Three invariants hold the whole thing together:

1. **Append-only authority + rebuildable projections** — trace, memory files,
   FTS/vector indexes, pattern tables: any projection can be wiped and rebuilt
   from its authority.
2. **Checkpoints lag the log** — dispatch order is the invariant; lag is
   repairable, lead means data loss.
3. **A tool call is the side-effect boundary** — one `replay: "safe"|"never"`
   marker drives crash recovery, retry tiering, and (future) concurrency.

Deep dive (per-stage design decisions, mistakes, and fixes, in Chinese):
`../PLAN.md` (workspace root, outside this repo) · `STATUS.md` (local only).

## The eval story (the honest part)

- **Deterministic judging first**: file assertions, and — for coding tasks —
  the repo's own test suite (`expectTestPass`: exit 0 = pass). The LLM judge is
  only consulted for tasks that opt in, never for the main gate.
- **The toolset is part of the protocol**: baselines are matched per
  (task set, model, toolset); a demo-toolset baseline and a coding-toolset eval
  are different protocols.
- **Infra failures are not task failures**: rate limits / quota / auth
  (`429`, Aliyun `Arrearage` wrapped in HTTP 400, …) mark the report
  **INVALID** — a verdict computed from runs that never executed cannot gate
  anything. This guard has caught three contaminated reports in production.
- **Findings so far** (real runs, all in the ledger):
  - strong models sit at the pass-rate ceiling on simple domains — no skill
    can show value there;
  - headroom appears where difficulty × model-weakness intersect (a qwen3-8b
    baseline on multi-file bug-fixes: 2/9);
  - verification habits only pay off if the checker can *recognize* the
    violation — weak models mis-sort backwards and re-verify the same wrong
    order, so the skill teaches **mechanical strategies** (sort ascending,
    then reverse) instead of "check carefully".

## Repository layout

```text
src/
  runtime/    run lifecycle, resume, permissions, limits, coding/demo toolsets
  execution/  checkpoint, crash recovery, fault injection
  trace/      schema, recorder (dual-write), query, replay, reconciliation
  context/    system-prompt assembly, compaction, workspace tree
  memory/     markdown store, FTS + embedding recall, distiller
  learning/   pattern miner, skill candidate, eval framework
  skills/     pi-compatible format, promotion, retrieval, verification
  storage/    node:sqlite (WAL), migrations, repos
  cli/        agent-harness CLI
evals/        task sets + fixture repos (multi-file bug-fix)
tests/        119 tests, no API key required
```

## Status & roadmap

Stages 1–14 complete (durable core → trace/replay → memory → permissions →
fault tolerance → skill loop → eval framework → coding agent v1 → coding eval
set). Remaining: finish the coding-domain gated eval (provider-quota-bound),
demo repositioning, CI hardening. Known limitations and the full decision log
live in `../PLAN.md` (Chinese).
