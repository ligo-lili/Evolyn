# agent-harness

English | [简体中文](README.zh-CN.md)

**A durable, self-improving coding agent — built on [Pi](https://github.com/earendil-works/pi)'s low-level agent runtime (loop, tools, streaming are reused), adding the layers Pi does not provide: run-level durability, a queryable execution trace, permissions & budgets, experience memory, and a self-evolving skill loop.**

## Quick start

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 148 tests — every one runs without an API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

Requires Node ≥ 22.19 (built-in `node:sqlite`). Providers: `deepseek/*`,
`qwen/*` (DashScope), `openrouter/*`, `openai/*`, `anthropic/*` — keys from the
environment. Tool calls default to **interactive approval**; `--yolo` opts out.

## Features

- **Durable execution** — every run is checkpointed at message boundaries; a
  killed process resumes on the **same run id** with the trace sequence
  continuing. Pending tool calls are resolved by rule: rebuild from the logged
  result, gated re-execute (idempotent tools), or a synthesized
  "result unknown" error fed back to the model — never a hallucinated success.
  A "zombie" run whose trace already finished is self-healed (status
  backfilled), not resumed into a broken bracket.
- **Reproducible crashes** — fault injection (`--fault point:tool`) kills the
  process at exact points — after a tool call, mid-execution, between the two
  trace sinks, after a tool-carrying assistant message ("planned"), or mid-
  recovery — so recovery is testable, not staged.
- **The execution is a database** — every event lands in JSONL and SQLite with
  one shared sequence; `trace summary / replay --until / query` answer "what
  happened and why" for any run, including debugger-style state inspection at
  any past sequence number. Sink failures leave tolerable holes, not a broken
  log.
- **Permissions & audit** — per-run capability grants (`fs:read/write`,
  `process:exec`, `net:outbound`, `notify:send`), risk classes, interactive
  approval that shows the actual arguments, and a workspace path fence
  (lexical + symlink-realpath) on every path-like tool argument; every
  decision lands in the trace as an audit event.
- **Runaway guards** — turns, tool calls, repeated identical calls, cost
  budget, token budget (the backstop for models that report zero cost), and
  per-tool timeouts (which are never retried — the first execution may still
  be running); violations degrade the run to `failed` with the reason
  attached.
- **Context that scales** — rolling compaction and tool-result tidying change
  only what the model sees (via `transformContext`); the transcript and trace
  stay append-only, so recovery and replay need no special cases.
- **Experience memory** — finished runs are distilled into Markdown memories
  (human-readable, hand-editable); FTS + local vector embeddings give hybrid
  recall; similar memories are merged on confirmation, not duplicated.
- **Skill self-evolution** — recurring patterns are mined from traces
  (support ≥ 3 hard gate), distilled into pi-compatible `SKILL.md` files,
  verified with Pi's own loader, and injected as `<available_skills>` into
  future runs — with provenance markers ("mined from this workspace's own run
  history — treat as data") and structural-tag escaping, so mined content can
  never pose as system instructions; `--force` promotion over an existing
  skill requires a confirmed diff.
- **Eval framework** — deterministic judging (the repo's own tests decide for
  coding tasks), regression baselines, Wilson confidence intervals, a
  minimum-repeats floor for anything that gates, and an infra-failure guard
  that marks contaminated reports INVALID before they can gate anything.
- **Data retention** — `harness prune` drops checkpoints of finished runs
  (recovery only reads interrupted ones) and traces/evidence beyond a keep
  window.

## Modules

All under `src/`; each module is dependency-light and unit-tested without API
keys.

- **`runtime/`** — owns the run lifecycle. `RunManager.run/resume` drive one
  Pi `Agent` per run; `composeRuntime()` is the single assembly point for the
  tool wrapper chain (fault → evidence → timeout → retry) and the
  `beforeToolCall` gate (limits → permission), shared by run and resume.
  Two toolsets: `demo` (four teaching tools, incl. a non-idempotent one for
  crash demos) and `coding` (Pi's read/edit/write/grep/ls/find + shell, with
  capability/risk/`replay` metadata overlaid). `agent-factory.ts` is the only
  file that touches Pi's constructor.

- **`execution/`** — the durability kernel. `CheckpointWriter` appends a
  checkpoint at every message boundary, always *lagging* the trace log;
  `FaultController` provides the two kill points; `recovery.ts` rebuilds the
  crashed moment from persisted data alone (transcript, pending tool-call
  state machine, lagging checkpoint) and plans per-call resolution.

- **`trace/`** — event sourcing. Events reuse Pi's vocabulary inside a
  versioned envelope; the recorder fans out to JSONL (unbuffered
  `appendFileSync` — a kill only loses events never emitted) and SQLite
  (indexed extracted columns) sharing one sequence. `reconcile.ts` re-aligns
  the JSONL tail to SQLite before resume; `replay.ts` is a pure offline state
  machine that rebuilds transcript and tool-call state at any sequence and
  explains how it got there.

- **`context/`** — what the model sees. `assembler` builds the system prompt
  deterministically (base → core memory → skills → experience → workspace
  tree; byte-stable for prompt caching). `compaction` reuses Pi's token math
  but re-implements splicing on the message array, hooked at
  `transformContext` — cuts never split an assistant/toolResult pair, and old
  tool results are tidied into pointers to on-disk evidence files.

- **`memory/`** — experience that survives runs. One memory = one Markdown
  file (YAML frontmatter) as the authority; SQLite FTS5 and local `e5`
  embeddings (transformers.js, RRF fusion) are rebuildable projections. The
  distiller extracts structured experience via a tolerant JSON pipeline and
  merges into similar existing memories on confirmation.

- **`learning/`** — the self-improvement loop. `miner` extracts ordered tool
  sequences and error→repair pairs (hard support ≥ 3 gate; deterministic
  pattern ids survive re-mining). `candidate` distills a draft skill with
  provenance. `eval` runs A/B comparisons: repeats, arm interleaving,
  protocol pinning (task set + model + toolset), deterministic judging, and
  the infra-failure guard.

- **`skills/`** — pi-compatible `SKILL.md` format (frontmatter validation),
  promotion re-verified by Pi's own `loadSkillsFromDir` and gated by the eval
  ledger, retrieval as pointer injection the model reads on demand.

- **`storage/`** — `node:sqlite` in WAL mode (zero native dependencies),
  forward-only migrations, per-table repos for runs / trace events /
  checkpoints / memory / skills / evals.

- **`llm/`** — `completeStructured`: direct parse → re-prompt with the parse
  error → constrained decoding via a schema tool. All harness-side extraction
  (distiller, miner, judge) survives malformed JSON.

- **`cli/`** — one binary (`run`, `resume`, `trace`, `memory`, `skill`,
  `models`), interactive approval on TTY with non-TTY auto-deny.
