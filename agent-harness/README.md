# agent-harness

English | [简体中文](../README.md)

**A durable, self-improving coding agent** built on [Pi](https://github.com/earendil-works/pi)'s
low-level agent runtime. Pi supplies the loop, tools and streaming; this project
adds the layers it does not: run-level durability, a queryable execution trace,
permissions and budgets, experience memory, and a self-evolving skill loop.

## Quick start

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # full suite — every test runs without an API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

Requires Node ≥ 22.19 (built-in `node:sqlite`). Providers: `deepseek/*`,
`qwen/*` (DashScope), `openrouter/*`, `openai/*`, `anthropic/*` — keys from the
environment. Tool calls default to **interactive approval**; `--yolo` opts out.
CI runs build, typecheck, lint and the full suite on a windows/ubuntu × Node
22/24 matrix.

## Interactive mode

```powershell
npm run harness -- chat --model deepseek/deepseek-flash --tools coding
```

A Claude Code-style TUI: streaming markdown, tool cards (edits render diffs,
shell renders output tails), mid-run steering, `Esc` to interrupt, slash
commands with autocomplete (`/help /model /yolo /approval /tools /memory
/trace /compact /clear /quit`), and an approval dialog. A bare invocation on a
TTY equals `chat`; scripts should use `run`.

An interactive session **is** a durable run: the trace bracket spans the whole
conversation, so `resume <runId> --chat` recovers a crashed session and
continues it in the TUI. Runaway counters reset per submit; the cost and token
fuses stay cumulative across the session.

## Features

- **Durable execution** — runs checkpoint at message boundaries; a killed
  process resumes on the **same run id** with the trace sequence continuing and
  the toolset restored. Pending tool calls are resolved by rule — rebuild from
  the logged result, gated re-execution (idempotent tools), or a synthesized
  "result unknown" error — never a hallucinated success; an ambiguous partial
  ledger refuses to resume rather than risk duplicated side effects.
- **Reproducible crashes** — fault injection kills the process at exact points
  (after a tool call, mid-execution, between the two trace sinks, mid-recovery),
  so recovery is tested, not staged.
- **The execution is a database** — every event lands in JSONL and SQLite under
  one shared sequence; `trace summary / replay / query` answer "what happened
  and why" for any run, including debugger-style inspection at any past
  sequence number.
- **Permissions & guardrails** — per-run capability grants, risk classes and
  interactive approval that shows the actual arguments; a workspace path fence
  plus a write fence that keeps structured file tools out of the harness state
  directory (including relocated state locations). Turn, tool-call, repeat,
  cost and token budgets plus per-tool timeouts (never retried) fail the run
  with the reason attached. Every decision is an audit event in the trace.
- **Context that scales** — a block model and six budget lines drive a
  prompt-cache-first decision (`reuse / defer / compact / rebuild`) on every
  model call. Two reduction layers — deterministic tool-result trimming, then a
  strict-JSON rolling summary — keep the model view small while the transcript
  and trace stay append-only.
- **Read-only subagents** — the `explore` tool spawns a child agent with its
  own context window and a no-shell readonly toolset; intermediate reads never
  enter the parent conversation, and a crash mid-child replays safely on resume.
- **Experience memory** — dual-layer: evidence-backed **Core Memory** plus
  ordinary Markdown-file memories, written through three gates (deterministic
  filter → strict-JSON reflector → authorized write). Retrieval fuses
  chunk-level FTS with local vectors behind an explicit degrade chain
  (`mode` + reason on every result); quality is CI-gated by
  `npm run eval:memory`.
- **Skill self-evolution** — recurring patterns mined from this workspace's own
  trace history (support ≥ 3) are distilled into pi-compatible `SKILL.md`
  files and injected as pointers future runs read on demand. Mined content is
  provenance-marked and tag-escaped, so it can never pose as system
  instructions.
- **Eval framework** — deterministic end-state judging, protocol-pinned A/B
  comparisons, Wilson confidence intervals, and an infra-failure guard that
  invalidates contaminated reports; see [Eval](#eval).
- **Data retention** — `harness prune` bounds completed-run checkpoints,
  context watermarks, traces and evidence.

## Repository structure

```text
agent-harness/
  src/
    runtime/     run lifecycle — RunManager.run/resume and the shared assembly
                 point behind chat sessions; the composed tool chain
                 (fault → evidence → timeout → retry) and the limits → permission gate
    execution/   durability kernel — lagging checkpoints, fault injection, crash reconstruction
    trace/       event sourcing — dual JSONL+SQLite sinks sharing one sequence,
                 reconcile, pure offline replay state machine
    context/     what the model sees — deterministic assembler, block model,
                 two-layer compaction, prefix-decision loop
    memory/      cross-run experience — Markdown authority store, core memory,
                 hybrid search, reflection gates, the model's memory tools
    learning/    self-improvement — pattern miner, skill distiller,
                 A/B eval comparison (incl. cheat-resistant grading)
    skills/      pi-compatible SKILL.md format, eval-gated promotion, pointer retrieval
    storage/     node:sqlite (WAL), forward-only migrations, per-table repos
    llm/         completeStructured — malformed-JSON-tolerant extraction calls
    cli/         one binary: run / chat / resume / trace / memory / skill / models / prune
    modes/       interactive TUI (chat view, tool cards, approval dialog)
  evals/         task sets + fixture repos for the eval harness
                 (memory-retrieval, coding-fix, file-creation, file-precision,
                  coding-hard, coding-compact, open-ended)
  scripts/       utility CLIs — eval:coding, eval:memory, e2e:memory-hybrid,
                 calibrate_tokens, chaos, export-traces
  tests/         full suite — every test runs without an API key
  .claude/       eval campaign records — per-flow baselines, round-by-round
                 changes, results and report.html artifacts
```

Every module is dependency-light and unit-tested without API keys. Runtime
state lives in `.harness/` (SQLite ledger, traces, memory, evidence) and is
fully disposable except for the Markdown memory authority.

Cross-module invariants: the transcript and trace are **append-only**
(compaction only projects); `compose.ts` is the single tool-wrapping point;
Markdown is the **memory authority** (SQLite holds rebuildable projections);
recovery stays conservative (never a hallucinated success); and **decisions are
data** — recovery resolutions, context decisions and permission verdicts all
land in the trace.

## Eval

Three deterministic layers — no LLM judge except where a task opts in:

- **Unit / integration** — 283 tests, no API key required (CI matrix:
  windows/ubuntu × Node 22/24).
- **Memory retrieval gate** — `npm run eval:memory` (recall@5 + precision@5 +
  blind-spot check) gates CI; the real-model chain is
  `npm run e2e:memory-hybrid` (ledger-only — 30 MB model download).
- **Coding-agent eval runner** — `npm run eval:coding`: sandboxed per-case
  runs, deterministic end-state grading (fixture tests / exact file checks,
  with test files restored before grading — editing the tests cannot turn the
  grade green), resumable results, a report builder and a harness-integrity
  gate.

Campaign records live in `.claude/hillclimb/` (per-flow baselines,
round-by-round changes, results and `report.html`): regression baseline
89/90 → 90/90 (−22.4% output tokens after prompt tuning); quality probe 96.2%;
compaction fidelity, dual-arm (1/21 damage, +15% token tax); skill A/B (three
promoted skills read but unpaid — no measurable gain).

## CLI

| Command | What it does |
|---|---|
| `agent-harness [chat]` | interactive coding agent (REPL — see [Interactive mode](#interactive-mode)) |
| `agent-harness run "<task>"` | one task (`--model`, `--tools demo\|coding`, `--yolo`, `--capabilities`, `--fault`) |
| `agent-harness resume [runId] [--chat]` | recover an interrupted run on the same run id; `--chat` continues it in the TUI |
| `agent-harness trace show/summary/replay/query/list` | inspect and replay execution traces |
| `agent-harness memory core/list/search/rebuild/status/history/distill` | memory inspection and maintenance |
| `agent-harness skill mine/draft/promote/eval/baseline/list/retrieve/verify` | skill mining, promotion and A/B eval |
| `agent-harness models` | list providers and models |
| `agent-harness prune [--deep] [--dry-run]` | data retention |
