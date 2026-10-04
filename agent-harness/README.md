# agent-harness

English | [简体中文](README.zh-CN.md)

**A durable, self-improving coding agent — built on [Pi](https://github.com/earendil-works/pi)'s low-level agent runtime (loop, tools, streaming are reused), adding the layers Pi does not provide: run-level durability, a queryable execution trace, permissions & budgets, experience memory, and a self-evolving skill loop.**

## Quick start

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 229 tests — every one runs without an API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

Requires Node ≥ 22.19 (built-in `node:sqlite`). Providers: `deepseek/*`,
`qwen/*` (DashScope), `openrouter/*`, `openai/*`, `anthropic/*` — keys from the
environment. Tool calls default to **interactive approval**; `--yolo` opts out.

## Features

- **Durable execution** — every run is checkpointed at message boundaries; a
  killed process resumes on the **same run id** with the trace sequence
  continuing, and the run's toolset is restored from the persisted run row
  (a crashed `--tools coding` run does not resume against the demo default). Pending tool calls are resolved by rule: rebuild from the logged
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
- **Context that scales** — context management rebuilt around a block model
  (system / conversation / tool-round / malformed blocks — tool-call ids must
  pair exactly via a Counter or the whole round degrades to a conservatively
  kept malformed block), six budget lines (input budget → 64k working
  preference → 0.80 soft trigger → forced ceiling → 0.45 deep target → an
  independent tool-result ledger), calibrated token estimation (chars/4 ×
  model-family coefficient, `scripts/calibrate_tokens.mjs` recalibrates against
  real traces), and a prompt-cache-first decision loop: every model call
  produces a `prefix_decision` — reuse / defer (over the soft line but the
  cached prefix is reusable: keep appending!) / compact / rebuild (prefix
  broken: deep-compact to the target). Layer 1 trims old tool results
  deterministically (head+tail with an evidence pointer, oldest-first whole-
  round removal, semantic JSON trimming for registered tools); layer 2 folds
  the prefix into a strict-JSON rolling summary (hard caps, a must-be-smaller
  gate, one retry with the failure reason, big-fold relaxation). All of it is
  model-view only: the transcript and trace stay append-only, and every
  decision lands in the trace as a `context_decision` event.
- **Read-only subagents (context isolation)** — the `explore` tool (coding
  toolset) spawns a full child agent with its own context window, a restricted
  readonly toolset (read/grep/ls/find — no shell, no recursion) and its own
  tighter limits + context management. The child's final answer arrives as the
  tool result; its intermediate reads never enter the parent's conversation.
  The child is a pure function of (task, workspace): the parent call is
  `replay: "safe"`, so a crash mid-subagent re-executes the whole child on
  resume through the ordinary recovery path — no nested checkpointing. The
  child's usage lands on the parent's cost/token fuses, its audit events
  (`subagent_start/end`) land in the trace, and its full transcript lands in
  the evidence directory.
- **Experience memory** — dual-layer: structured
  **Core Memory** (key upserts only, every entry carries `reason` +
  `source_statement` evidence, 2000-token injection budget) and **ordinary
  memories** (one Markdown file each, `M001…` ids, optimistic-lock
  `revision`, active/archive with a hard 25-active cap, atomic writes,
  version snapshots under `history/` (last 5, FIFO),
  `INDEX.md` projection). Writes go through **three gates**: a deterministic
  reflection gate → a strict-JSON `{action: none|create|update}` reflector →
  an authorized write (updates allowed only for ids the run actually READ —
  mechanism, not prompt). Retrieval is chunk-level FTS (trigram-probed) +
  local `e5` vectors fused by memory-level RRF with an explicit degrade chain
  (`mode` + `degrade_reason` on every result) and a bounded accessCount
  ranking boost. The vector path takes effect once the background backfill
  completes — until then every search honestly reports FTS-only; runs with
  no vectors never load the model at all. Startup reconciles from the
  Markdown authority, embeddings backfill in the background with bounded
  backoff (CLI drains it before exit; `memory: { hybrid: false }` opts out).
  The model gets `memory_read / memory_search / memory_create /
  memory_update / memory_archive / core_memory_update` (coding toolset by
  default). Retrieval quality is gated in CI by `npm run eval:memory`
  (recall@5 + blind-spot check over `evals/memory-retrieval.json`).
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
  tree; byte-stable for prompt caching). The rest is a two-layer context
  manager hooked at `transformContext`: `blocks` partitions the transcript
  into the four block types (the minimum unit of every compression decision —
  never a half tool-round); `tokens` estimates with a calibrated model-family
  coefficient and blends the last measured usage; `budget` derives the six
  lines; `reducers/tool` is the deterministic layer-1 (truncate head+tail with
  an evidence pointer, remove whole rounds oldest-first, semantic JSON
  trimming, resume-boundary aware); `summarizer` + `reducers/conversation`
  are the model-driven layer-2 (strict JSON rolling summary with hard
  validation, a covered-message watermark, and id/tool-call-precise prefix
  replacement); `compaction` is the orchestrator producing a `prefix_decision`
  (reuse/defer/compact/rebuild) for every request — the raw history is never
  modified, only projected. `compose.ts` is the shared tool-wrapper chain and
  the gate composition, reused verbatim by the explore subagent as
  "run-lite" (restricted toolset, own limits, own enforcer).

- **`memory/`** — experience that survives runs, per `memory-design.md`.
  `model` (M### record + 900/180/16 chunking with `title | summary` semantic
  headers and per-chunk sha256), `store` (Markdown authority: CORE.md /
  INDEX.md / active / archive, atomic writes, mutation guard, capacity),
  `core` (evidence-backed key upserts, token-budgeted injection), `search`
  (chunk index + FTS5 tokenizer probe + RRF-by-memory fusion, degrade chain,
  reconcile, background embedding backfill with conditional writes),
  `reflection` (deterministic gate → strict-JSON reflector → authorized
  write), `tools` (the model's memory surface).

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
