#!/usr/bin/env node
// coding-tasks eval runner (build-eval / hillclimb) for agent-harness.
//
//   npm run eval:coding -- --variant baseline --model deepseek/deepseek-flash --reps 2
//
// Runs the harness end-to-end (`RunManager` — the same entry as
// `agent-harness run --tools coding`) over the repo's coding task sets
// (multi-file bug-fix fixtures + file tasks), grades on the END STATE
// (judgeRun: the fixture's own `npm test` / file-content checks), and writes
// the build-eval contract into .claude/hillclimb/coding-tasks/:
//   baseline/results.jsonl, baseline/traces/<id>_rep<k>.json, baseline/errors.jsonl,
//   baseline/progress.txt, _state.json (metrics / perf / harness pin).
//
// Derived from the claude-api skill's runner-scaffold.mjs — the machinery
// below the "fill these in" line is scaffold code kept verbatim (resume by
// (case,rep), hard per-case wall-clock ceiling, jittered backoff, errors
// sidecar, symlink-refusing I/O, harness-integrity gate, served-model check).
// Flow-specific deviations, all deliberate:
//   - every case runs in a wiped sandbox cwd (.claude/hillclimb/coding-tasks/
//     _workspace): the agent's workspace, the fixture repos (repos/) and the
//     harness runtime state (.harness/ db+traces+memory) all live there, so
//     eval runs never touch the repo's real .harness or its working tree.
//     Fixture templates are absolutized before the chdir; because the sandbox
//     cwd is process-global, --concurrency is pinned to 1.
//   - rows are always status "ok": a run that died to the harness's own
//     guardrails (turn/tool/cost caps) is a model failure and must stay in
//     the pass-rate means (judgeRun scores it 0). Only provider-infrastructure
//     failures, fixture errors, timeouts and grader crashes go to errors.jsonl
//     — failed attempts, never scored.
//   - model: pi does not surface the serving model id, so rows record the
//     requested spec (the scaffold's served-model check then passes vacuously;
//     documented limitation, not an assertion).
//   - the grader restores pristine test.js/package.json from the fixture
//     template before running the test command (cheat guard); when it fires,
//     the row's meta carries restored_test_files.
//
// Run once with --approve-harness after reviewing; that command is then the
// hillclimb entry point (add a v1/ variant later; its results land beside
// baseline/ under the same flow dir).

import { createHash } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInfraFailure, judgeRun, loadTaskSet, prepareTaskWorkspace, readBackVerified } from '../dist/learning/eval.js';
import { RunManager } from '../dist/runtime/run-manager.js';
import { resolveModel } from '../dist/providers.js';

// Captured at load: fills chdir into the sandbox later, and the harness-path
// list in _state.json is spelled relative to the invocation dir (repo root —
// npm scripts run from the package root).
const REPO_ROOT = process.cwd();

// Every output write refuses symlinks: the flow dir is model-influenced, and a
// prompt-injected round can plant `results.jsonl -> ~/.bashrc` where the next
// unattended run would append. POSIX opens O_NOFOLLOW (a symlink fails with
// ELOOP); Windows - where Node leaves O_NOFOLLOW undefined and Bun defines a
// meaningless value - lstat-refuses first. Symlinked parent dirs are
// refused the same way. Same discipline as the report builders' reads.
const WIN = process.platform === 'win32';
const NOFOLLOW = WIN ? 0 : FS.O_NOFOLLOW;
// A guard that cannot tell must refuse: only "no such entry" reads as absent;
// any other lstat failure (EACCES, ENAMETOOLONG, ...) is rethrown, never "no".
const lstatOrNull = p => { try { return lstatSync(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
const isSymlink = p => lstatOrNull(p)?.isSymbolicLink() === true;
// Stderr lines interpolate model-influenced bytes (case ids, error text that
// can echo model output, JSON.parse messages). Strip escape sequences and
// control characters, as build-report-lite.mjs's eprint does, so a planted
// OSC/CSI can't retitle the terminal or forge output lines.
const ESC_SEQ = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const termSafe = s => String(s).replace(ESC_SEQ, '').replace(CONTROL, '');
const eprint = (...a) => console.error(...a.map(termSafe));
// The leaf checks above can't see a symlink on an INTERMEDIATE component
// (lstat and open both resolve those silently), so every open is also bound
// to the flow root: main() captures realpathSync(flow) once, and any path
// whose resolved parent leaves it - e.g. `vdir` or the flow dir itself
// replaced by a directory symlink - is refused when the check sees it.
// Residual, all platforms: the check and the open are separate path lookups
// (Node's sync fs has no openat-style call), so a directory swapped for a
// symlink in between is still followed. This stops a planted link, not a
// writer racing the run.
let flowRealRoot = null;
function assertInFlow(dir, what) {
  if (flowRealRoot == null) throw new Error(`refusing to ${what}: flow root not resolved yet`);
  const dirReal = realpathSync(dir);
  if (dirReal !== flowRealRoot && !dirReal.startsWith(flowRealRoot + (WIN ? '\\' : '/')))
    throw new Error(`refusing to ${what}: ${dir} resolves outside the flow directory`);
}
function openNoFollow(p, flags) {
  if (isSymlink(dirname(p))) throw new Error(`refusing to open through symlinked directory: ${dirname(p)}`);
  assertInFlow(dirname(p), 'open');
  if (WIN && isSymlink(p)) throw new Error(`refusing to open through symlink: ${p}`);
  const fd = openSync(p, flags | NOFOLLOW, 0o644);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`refusing to use non-regular file: ${p}`);
    // O_NOFOLLOW and lstat cannot see a hard link: a second name for a file
    // outside the flow dir opens as an ordinary regular file. Nothing the
    // runner creates has more than one link, so refuse any that does.
    if (st.nlink > 1) throw new Error(`refusing to use ${p}: it has a second hard link (another name for the same file); replace it with a plain copy if it is yours`);
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}
// writeFileSync on the fd loops until every byte lands (a bare writeSync is
// one write(2) that may return short on ENOSPC and silently truncate a
// results row or trace).
// Opened without O_TRUNC and truncated only after openNoFollow's checks, so a
// refused file keeps its bytes.
function writeFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT);
  try { ftruncateSync(fd, 0); writeFileSync(fd, data); } finally { closeSync(fd); }
}
// POSIX appends atomically under O_APPEND with no position. On Windows, Bun
// writes an O_APPEND handle at offset 0 unless given a position, so there the
// write starts at the current size and re-issues any short write.
function appendFileNoFollow(p, data) {
  const fd = openNoFollow(p, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND);
  try {
    if (!WIN) { writeFileSync(fd, data); return; }
    const buf = Buffer.from(data);
    const start = fstatSync(fd).size;
    for (let off = 0; off < buf.length;) {
      const n = writeSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) throw new Error(`append to ${p} made no progress`);
      off += n;
    }
  } finally { closeSync(fd); }
}
// Reads of the frozen pairwise refs get the same discipline as writes (same
// open guard): the flow dir is model-influenced, so `baseline/ref/<id> ->
// ~/.ssh/id_rsa` planted after the startup preflight must not be read into the
// judge prompt. lexists probes with lstat so a planted symlink still
// counts as "present" at the freeze guard (never overwritten - or followed).
const lexists = p => lstatOrNull(p) != null;
function readFileNoFollow(p) {
  const fd = openNoFollow(p, FS.O_RDONLY);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
// null when the file is absent; any other failure (a planted link included) throws.
function readIfPresent(p) {
  try { return readFileNoFollow(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
function mkdirNoFollow(dir) {
  if (isSymlink(dir)) throw new Error(`refusing to use symlinked directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  // Check after creating: mkdirSync(recursive) follows symlinked ancestors,
  // so a dir minted through one resolves outside the flow root and is refused
  // here before any file lands in it.
  assertInFlow(dir, 'create directory');
}
// Frozen pairwise refs may carry an extension; reader and freeze-guard probe
// the same list so a suffixed ref never gets an extensionless shadow.
const REF_EXTS = ['', '.html', '.txt', '.json'];

// --- fill these in ----------------------------------------------------------

// tags[0] is the report's primary grouping key (one section per family).
const SETS = [
  { file: 'evals/coding-fix-v1.json', family: 'bug-fix' },
  { file: 'evals/file-creation.json', family: 'file-creation' },
  { file: 'evals/file-precision-v1.json', family: 'file-precision' },
];

let sandboxDir = null;

/** The sandbox cwd for this pass — created once so withSandbox can chdir into
 *  it; each runCase resets it per case (see there). Resume needs nothing from
 *  a previous sandbox: completed rows are on disk and every fixture is reset
 *  from its template before each run. */
function prepareSandbox(flow) {
  const dir = resolve(REPO_ROOT, flow, '_workspace');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return the list of input cases. Each must have a stable `id`. */
async function loadCases(args) {
  sandboxDir = prepareSandbox(args.flow);
  // Default = the three family sets; --sets "file[:family],..." overrides
  // (a per-task `tag` field in the task set wins over the set-level family).
  const sets = args.sets
    ? args.sets.split(',').map((s) => { const [file, family = 'other'] = s.trim().split(':'); return { file, family }; })
    : SETS;
  const only = args.cases ? new Set(args.cases.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const cases = [];
  for (const { file, family } of sets) {
    const set = loadTaskSet(resolve(REPO_ROOT, file));
    for (const t of set.tasks) {
      if (only && !only.has(t.id)) continue;
      const task = { ...t };
      // The run executes with cwd = sandbox, so a repo-relative fixture
      // template would resolve inside it - absolutize against the repo root.
      if (task.setupRepo?.template) {
        task.setupRepo = { ...task.setupRepo, template: resolve(REPO_ROOT, task.setupRepo.template) };
      }
      cases.push({ id: t.id, prompt: t.task, tags: [t.tag ?? family], task });
    }
  }
  if (!cases.length) throw new Error('no cases loaded - check --sets / --cases / the task-set files');
  return cases;
}

/** Run fn with the process cwd inside the sandbox (process-global; the flow
 *  is pinned to --concurrency 1 for exactly this reason). */
async function withSandbox(fn) {
  const prev = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

/**
 * Run the app on one input. Return everything the grader and the report need.
 * `ctx.model` and `ctx.variant` are the CLI args.
 */
async function runCase(c, ctx) {
  return withSandbox(async () => {
    // Audit clean-state requirement: wipe EVERYTHING the previous case left —
    // stray workspace files, other cases' repos/, and the harness's own
    // .harness (db/traces/memory) — so every trial starts from zero and the
    // system prompt's workspace tree shows only this case's setup (the pilot
    // showed a stale sorted-list.txt being explored mid-run). Children are
    // removed, never the dir itself (it is the process cwd right now).
    for (const entry of readdirSync(sandboxDir)) {
      rmSync(join(sandboxDir, entry), { recursive: true, force: true });
    }
    try {
      prepareTaskWorkspace(c.task); // template reset - every run starts clean
    } catch (err) {
      const e = new Error('fixture setup failed: ' + (err?.message || err));
      e.failure_class = 'fixture_error';
      throw e;
    }
    const manager = new RunManager();
    try {
      const result = await manager.run({
        task: c.task.task,
        model: resolveModel(ctx.model),
        tools: 'coding',
        // Unattended by design, exactly like the repo's own eval arms: a task
        // set is operator-provided executable configuration.
        approval: { mode: 'auto-approve' },
        reporter: { onEvent: () => {} },
        skills: false,
      });
      const messages = result.messages;
      const raw = { taskId: c.id, status: result.record.status, error: result.record.error };
      if (isInfraFailure(raw)) {
        // 429/quota/auth: not a task failure - errors.jsonl, never scored.
        const e = new Error('provider infrastructure failure: ' + (result.record.error ?? result.record.status));
        e.failure_class = 'infra';
        throw e;
      }
      const usage = result.usage;
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      return {
        transcript: toTranscript(result.record.systemPrompt, messages),
        verified: readBackVerified(messages),
        // pi does not surface the serving model id; record the requested spec
        // (equal-model, so the scaffold's served-model check passes vacuously).
        model: ctx.model,
        usage: usage
          ? {
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheWrite,
            }
          : undefined,
        stop_reason: lastAssistant?.stopReason,
        // Graded failures stay status-ok: a run cut short by the harness's own
        // guardrails is a model failure and belongs in the means (judgeRun
        // turns it into pass 0). Only errors.jsonl attempts stay unscored.
        status: 'ok',
        raw,
        toolCalls: messages.filter(m => m.role === 'toolResult').length,
      };
    } finally {
      manager.close();
    }
  });
}

/**
 * Grade one output on the end state. Deterministic: judgeRun checks the
 * fixture repo's test command / the expected files, restoring pristine
 * test.js + package.json first (cheat guard).
 */
async function gradeCase(c, run, ref, ctx) {
  return withSandbox(async () => {
    let judged;
    try {
      judged = judgeRun(c.task, run.raw, 1);
    } catch (err) {
      const e = new Error('grader crashed: ' + (err?.message || err));
      e.failure_class = 'grader_error';
      throw e;
    }
    if (judged.infra) {
      const e = new Error('infrastructure failure during grading: ' + (judged.reason ?? ''));
      e.failure_class = 'infra';
      throw e;
    }
    if (Array.isArray(judged.restored) && judged.restored.length) {
      // The cheat guard fired: the agent had edited fixture test files and the
      // grader restored them from the template. Surface it on the row.
      c.meta = { ...(c.meta ?? {}), restored_test_files: judged.restored };
    }
    return {
      grade: { pass: judged.pass ? 1 : 0, verified: run.verified ? 1 : 0 },
      explanation: judged.pass ? undefined : { pass: judged.reason ?? 'failed' },
    };
  });
}

/** Side-channel perf fields beyond the built-ins (latency_s etc.). */
function perfFrom(run) {
  return {
    tool_calls: run.toolCalls ?? 0,
    ...(run.usage ? { in_tokens: run.usage.input_tokens ?? 0, out_tokens: run.usage.output_tokens ?? 0 } : {}),
  };
}

/** AgentMessage[] -> the trace Turn[] shape (SCHEMA.md): each tool call and
 *  result is its own turn; thinking attaches to the turn it preceded. */
function toTranscript(systemPrompt, messages) {
  const turns = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) turns.push({ role: 'system', content: systemPrompt });
  const textOf = content => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content, null, 2);
    return content
      .map(b => (b?.type === 'text' ? b.text : b?.type === 'thinking' ? '' : JSON.stringify(b, null, 2)))
      .filter(s => s)
      .join('\n');
  };
  for (const m of messages) {
    if (m.role === 'user') {
      turns.push({ role: 'user', content: textOf(m.content) });
    } else if (m.role === 'assistant') {
      let thinking;
      for (const b of m.content ?? []) {
        if (b?.type === 'thinking' && typeof b.thinking === 'string') {
          thinking = thinking ? thinking + '\n' + b.thinking : b.thinking;
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const turn = { role: 'assistant', content: b.text };
          if (thinking) { turn.thinking = thinking; thinking = undefined; }
          turns.push(turn);
        } else if (b?.type === 'toolCall') {
          const turn = { role: 'tool_call', name: b.name, content: JSON.stringify(b.arguments ?? {}, null, 2) };
          if (thinking) { turn.thinking = thinking; thinking = undefined; }
          turns.push(turn);
        }
      }
    } else if (m.role === 'toolResult') {
      turns.push({ role: 'tool_result', content: textOf(m.content) });
    }
  }
  return turns;
}

// --- harness (you usually won't need to touch below this line) --------------

function parseArgs(argv) {
  const a = { flow: '.claude/hillclimb/coding-tasks', variant: 'baseline',
              model: 'deepseek/deepseek-flash', reps: 1, concurrency: 1, timeoutS: 600,
              cases: undefined, sets: undefined, approveHarness: false };
  // A flag at the end of argv would otherwise consume undefined - which for
  // --model equals the default and silently disables the served-model check.
  const val = (i) => { if (argv[i] === undefined) { eprint(`missing value for ${argv[i - 1]}`); usage(); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--flow') a.flow = val(++i);
    else if (k === '--variant') a.variant = val(++i);
    else if (k === '--model') a.model = val(++i);
    else if (k === '--reps') a.reps = +val(++i);
    else if (k === '--concurrency') a.concurrency = +val(++i);
    else if (k === '--timeout-s') a.timeoutS = +val(++i);
    else if (k === '--cases') a.cases = val(++i);
    else if (k === '--sets') a.sets = val(++i);
    else if (k === '--approve-harness') a.approveHarness = true;
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { eprint(`unknown argument: ${k}`); usage(); process.exit(2); }
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) {
    // The report only reads directories named 'baseline' or 'v<N>' - any other
    // name runs to completion but spends the pass into a directory the Summary,
    // trajectory, and budget arithmetic never see.
    eprint(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
    usage(); process.exit(2);
  }
  if (!Number.isFinite(a.timeoutS) || a.timeoutS < 0
      || a.timeoutS * 1000 > 2147483647 // setTimeout clamps >2^31-1 ms to 1 ms - the ceiling would fire instantly
      || !Number.isInteger(a.reps) || a.reps < 1
      || !Number.isInteger(a.concurrency) || a.concurrency < 1) { usage(); process.exit(2); }
  if (a.concurrency !== 1) {
    // The sandbox cwd (and the harness run's own process cwd) is process-global.
    eprint('--concurrency must be 1 for this flow (the harness run chdirs a process-global sandbox)');
    process.exit(2);
  }
  return a;
}
function usage() {
  eprint('usage: node scripts/eval-coding.mjs --variant baseline|v<N> [--model ID] [--reps N] [--cases id1,id2] [--flow DIR] [--timeout-s N (0 = no ceiling)] [--approve-harness]');
  eprint('  defaults: --flow .claude/hillclimb/coding-tasks --model deepseek/deepseek-flash --reps 1 (use --reps 2+ for a baseline) --timeout-s 600');
}

// Harness integrity gate. The hillclimb loop gets this runner command
// allowlisted for the session and then runs rounds unattended, while the
// per-round change (proposed by an analyzer fed untrusted transcripts) may
// legitimately edit harness code. Without this gate a round that rewrites the
// runner would execute attacker-chosen code on the next unattended run under
// the user's one-time approval. So: sha256 over this file, any lockfile
// beside it or in the directory the runner is invoked from (dependency drift
// is harness drift too; with neither, a note says so), plus
// every path in `_state.json.harness_paths` (relative to the directory the
// runner is invoked from, i.e. the repo root); compare to
// `_state.json.harness_sha`; refuse on absent/mismatch unless a human passes
// --approve-harness, which records the new sha. That write is the one
// sanctioned exception to "never write _state.json".
//
// Scope, stated plainly: this is a change detector, not a security boundary.
// The sha, the path list and this file all live where the loop agent can
// write, so an agent that is already prompt-injected can forge the record or
// pass --approve-harness itself. What it catches is the common case - a
// round's harness edit reaching an unattended run unreviewed - and what
// actually bounds an unattended run is the permission allowlist the user
// grants the runner command (scope it to this exact command line, not a
// prefix). Installed dependencies beyond the lockfile are outside the digest.
function checkHarness(statePath, st, approve) {
  const self = fileURLToPath(import.meta.url);
  const listed = Array.isArray(st.harness_paths) ? st.harness_paths.map(String) : [];
  const lockfiles = [...new Set([dirname(self), process.cwd()].flatMap(d =>
    ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'].map(f => join(d, f))))]
    .filter(f => existsSync(f));
  const paths = [...new Set([self, ...lockfiles, ...listed.map(p => resolve(p))])].sort();
  const h = createHash('sha256');
  const hashed = [];
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); }
    catch (e) {
      if (p === self) throw e;
      eprint(`warning: harness path '${relative(process.cwd(), p)}' not readable (${e?.code || 'error'}) - skipped`);
      continue;
    }
    h.update(relative(process.cwd(), p)).update('\0').update(buf).update('\0');
    hashed.push(relative(process.cwd(), p));
  }
  const sha = h.digest('hex');
  if (st.harness_sha === sha) return;
  // Said only here, where a person is about to approve or is being refused.
  if (!lockfiles.length) eprint('note: no lockfile beside the runner or in the current directory - dependency changes are outside the harness sha');
  if (approve) {
    st.harness_sha = sha;
    writeFileNoFollow(statePath, JSON.stringify(st, null, 2) + '\n');
    eprint(`harness approved: sha256 ${sha.slice(0, 12)} over ${hashed.length} file(s) recorded in ${statePath}`);
    return;
  }
  if (st.harness_sha == null) {
    eprint(`no approved harness sha in ${statePath} (computed ${sha.slice(0, 12)} over: ${hashed.join(', ')}).`);
    eprint('Review the harness, then run once with --approve-harness to record it.');
  } else {
    eprint(`harness changed since last approved run (files: ${hashed.join(', ')}); `
      + `approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
    eprint('Re-run with --approve-harness after reviewing the diff.');
  }
  process.exit(2);
}

// Transient provider errors (429 / overloaded / 5xx) retry with jittered
// exponential backoff - a zero-delay retry loop multiplies cost invisibly
// under rate limits and can turn one transient 429 into a torn-down batch.
// The attempt count lands in the row's meta (or the errors sidecar) so retry
// churn is visible in the data, not just the bill.
async function withBackoff(fn, retry, deadline = Infinity, tries = 5) {
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, not just before sleeps: once the case's
    // ceiling has passed, an abandoned chain must not issue another call
    // (e.g. a judge call after the app call consumed the whole ceiling).
    if (Date.now() >= deadline) {
      const e = new Error('wall-clock ceiling exceeded before attempt');
      e.failure_class = 'timeout';
      throw e;
    }
    try { return await fn(); } catch (e) {
      const status = e?.status ?? e?.response?.status;
      const transient = status === 429 || status === 529 || (status >= 500 && status < 600)
        || /overloaded|rate.?limit/i.test(String(e?.message ?? ''));
      if (!transient || attempt >= tries - 1) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      // Never start a retry that would outlive the case's wall-clock ceiling -
      // otherwise an abandoned chain keeps issuing API calls after the case failed.
      if (Date.now() + delay >= deadline) throw e;
      retry.count++;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Hard per-case wall-clock ceiling, independent of stream liveness - a hung
// SSE stream can emit keepalives forever, defeating inactivity-based timers.
// The underlying call may keep running; the case fails and the slot is freed.
function withTimeout(promise, seconds, label) {
  if (!(seconds > 0)) return promise;
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: exceeded ${seconds}s wall-clock ceiling`);
      e.failure_class = 'timeout';
      reject(e);
    }, seconds * 1000);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Case ids appear in file paths AND as the row/file join key the report uses,
// so rows, trace filenames, and frozen refs all carry the same path-safe id.
// When sanitization changes the id, a short content hash keeps distinct ids
// distinct ('case/1' vs 'case_1'); the original rides in meta.original_id.
function pathSafeId(id) {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, '_');
  // Idempotent by construction: anything already path-safe and within the
  // length bound - including this function's own truncated+suffixed output -
  // passes through unchanged. Long ids (URLs, prompt text as id) truncate to
  // 120 chars plus an 8-hex hash of the full original, so they fail here, not
  // at the trace write after the spend, and distinct ids stay distinct.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // lstat("link/") follows the final symlink, so a trailing separator on
  // --flow would blind every leaf isSymlink check below - strip it first.
  // Only Windows treats `\` as a separator; on POSIX it is a filename byte, so
  // splitting on it would walk prefixes that are not real path components.
  args.flow = args.flow.replace(WIN ? /(.)[\\/]+$/ : /(.)\/+$/, '$1');
  const flowSegments = args.flow.split(WIN ? /[\\/]/ : '/');
  // A `.`/`..` segment (e.g. a trailing `/.`) makes isSymlink(args.flow) below
  // resolve a different final component than the named dir - following a
  // planted link at the flow root - while join() collapses it and the absolute
  // branch skips the ancestor walk. Refuse dot segments outright
  // (absolute --flow stays supported).
  if (flowSegments.some(seg => seg === '.' || seg === '..')) {
    eprint(`refusing to run: --flow must not contain '.' or '..' segments, got '${args.flow}'`);
    process.exit(2);
  }
  const vdir = join(args.flow, args.variant);
  // Preflight every output path before the first model call: a planted
  // symlink would otherwise fail each case after its (billed) run.
  for (const p of [args.flow, join(args.flow, 'baseline'), vdir, join(vdir, 'traces'),
                   join(vdir, 'results.jsonl'), join(vdir, 'errors.jsonl'),
                   join(vdir, 'progress.txt'), join(args.flow, 'baseline', 'ref'), join(args.flow, '_state.json')])
    if (isSymlink(p)) { eprint(`refusing to run: ${p} is a symlink (the flow dir must hold regular files)`); process.exit(2); }
  // A relative --flow (the documented `.claude/hillclimb/<name>` layout) is
  // also lstat-walked component by component from the cwd: a pre-planted
  // link at an ancestor (`.claude/hillclimb -> elsewhere`) would otherwise
  // relocate the root capture below - the containment anchor itself - to the
  // attacker's target. An absolute --flow is the caller's own trust decision
  // and is not walked (an absolute ancestor link can be legitimate: /tmp on
  // macOS).
  if (!isAbsolute(args.flow)) {
    let walk = '';
    for (const part of flowSegments.filter(Boolean).slice(0, -1)) {
      walk = walk ? join(walk, part) : part;
      if (isSymlink(walk)) { eprint(`refusing to run: ${walk} is a symlink (ancestor of --flow)`); process.exit(2); }
    }
  }
  // Every later open/mkdir is bound to this resolved root (see assertInFlow):
  // create the flow dir when fresh (the preflight above refused a link at it
  // and, for a relative path, at every ancestor), then capture where it
  // really resolves.
  mkdirSync(args.flow, { recursive: true });
  flowRealRoot = realpathSync(args.flow);
  mkdirNoFollow(join(vdir, 'traces'));
  // _state.json is READ-ONLY here. The orchestrator owns it. Absent is fine
  // (a baseline-only run has no loop state yet), but present-and-unparsable
  // must not let the id-space gate below pass vacuously over a corrupt file.
  const statePath = join(args.flow, '_state.json');
  let st = {};
  // Read through the no-follow opener like every other flow-dir file; the
  // parse message is not echoed (it can quote the file's first bytes).
  const stateText = readIfPresent(statePath);
  if (stateText != null) {
    try { st = JSON.parse(stateText) || {}; }
    catch { eprint(`${statePath} exists but is not valid JSON - fix it before spending a pass`); process.exit(2); }
  }
  checkHarness(statePath, st, args.approveHarness);
  const ctx = { ...args, state: st };

  // Resume: which (id, rep) pairs already have a row?
  const resultsPath = join(vdir, 'results.jsonl');
  const done = new Set();
  for (const ln of (readIfPresent(resultsPath) ?? '').split('\n')) {
    if (!ln.trim()) continue;
    try { const r = JSON.parse(ln); done.add(`${r.prompt_id}\0${r.rep}`); } catch {}
  }
  // Rows key on the path-safe id (see pathSafeId), so resume must too.

  const cases = await loadCases(args);
  // Validate the id space before spending anything: duplicate path-safe ids -
  // including case-insensitive twins, which macOS/Windows filesystems collapse -
  // would silently overwrite traces and frozen refs; and a _state.json split id
  // that matches no case would silently shrink the scored denominator.
  const seen = new Map();
  for (const c of cases) {
    const k = pathSafeId(c.id).toLowerCase();
    if (seen.has(k)) {
      eprint(`duplicate case id after sanitization: '${c.id}' collides with '${seen.get(k)}'`);
      process.exit(2);
    }
    seen.set(k, c.id);
  }
  const safeIds = new Set(cases.map(c => pathSafeId(c.id)));
  for (const k of ['train_ids', 'val_ids', 'test_ids'])
    if (st[k] != null && !Array.isArray(st[k])) { eprint(`_state.json ${k} must be a list of ids`); process.exit(2); }
  for (const sid of [...(st.train_ids ?? []), ...(st.val_ids ?? []), ...(st.test_ids ?? [])]) {
    const s = String(sid); // the adapter joins with String() on both sides - numeric ids are fine
    if (safeIds.has(s)) continue; // matches a loaded case - definitionally valid
    if (s !== pathSafeId(s)) {
      // Can never match a row: rows key on path-safe ids. This is the silent
      // shrunken-denominator bug - fail before anything is spent.
      eprint(`_state.json split id '${s}' is not a path-safe id - record split ids exactly as they appear in results.jsonl's prompt_id`);
      process.exit(2);
    }
    // Well-formed but absent is legitimate (a trimmed top-K subset run) - note it, don't fail.
    eprint(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
  }
  const refDir = join(args.flow, 'baseline', 'ref');
  const tasks = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) {
    if (done.has(`${pathSafeId(c.id)}\0${rep}`)) continue;
    tasks.push({ c, rep });
  }
  eprint(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);

  let i = 0, ok = 0, fail = 0;
  const errorsPath = join(vdir, 'errors.jsonl');
  // A hard crash (power loss, ENOSPC) can leave a torn final line with no
  // trailing newline; the next append would merge two rows into one permanently
  // unparseable line. Isolate any fragment before appending anything.
  for (const p of [resultsPath, errorsPath]) {
    const tail = readIfPresent(p);
    if (tail && !tail.endsWith('\n')) appendFileNoFollow(p, '\n');
  }
  async function worker() {
    while (i < tasks.length) {
      const { c, rep } = tasks[i++];
      const safeId = pathSafeId(c.id);
      const t0 = Date.now();
      let lastRun = null;    // survives into the catch - billed spend on a failed attempt
      let rowWritten = false; // set once the results row lands - the attempt is scored
      const deadline = args.timeoutS > 0 ? t0 + args.timeoutS * 1000 : Infinity;
      const appRetry = { count: 0 }, judgeRetry = { count: 0 };
      try {
        // One ceiling over the whole case - app call, identity check, and grading -
        // so a hung judge stream can't hold the slot either.
        const { run, g, latency_s } = await withTimeout((async () => {
          let tAttempt = t0;
          const run = await withBackoff(() => { tAttempt = Date.now(); return runCase(c, ctx); },
            appRetry, deadline);
          lastRun = run;
          // latency_s = the final app attempt only; backoff sleeps, failed
          // attempts, and judge time are excluded (retry counts are in meta).
          const latency_s = (Date.now() - tAttempt) / 1000;
          // Serving identity: fail loudly when the response was served by a model
          // other than the one requested. (This flow records the requested spec -
          // pi does not surface the serving id - so the check passes vacuously;
          // kept for the day runCase can return a real served model.)
          if (ctx.model && run.model && run.model !== ctx.model) {
            const base = ctx.model.replace(/-latest$|-0$/, '');
            const rest = String(run.model).startsWith(base)
              ? String(run.model).slice(base.length) : null;
            if (!(rest != null && /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest))) {
              const e = new Error(`served model ${run.model} != requested ${ctx.model}`);
              e.failure_class = 'serving_substitution';
              throw e;
            }
          }
          // Frozen pairwise reference (never regenerated): baseline/ref/<id>.*
          let ref = null;
          if (args.variant !== 'baseline') {
            const p = join(refDir, safeId);
            // A planted symlink throws (ELOOP) rather than feeding the judge
            // its target; the case then fails loudly instead of leaking.
            for (const ext of REF_EXTS) {
              try { ref = readFileNoFollow(p + ext); break; }
              catch (e) { if (e?.code !== 'ENOENT') throw e; }
            }
          }
          const g = await withBackoff(() => gradeCase(c, run, ref, ctx), judgeRetry, deadline);
          return { run, g, latency_s };
        })(), args.timeoutS, `${c.id} rep${rep}`);
        const row = {
          prompt_id: safeId, rep, prompt: c.prompt ?? c.input ?? c.id,
          tags: c.tags, attachments: c.attachments,
          meta: safeId !== String(c.id) || appRetry.count || judgeRetry.count
            ? { ...(c.meta ?? {}),
                ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
                ...(appRetry.count ? { retries: appRetry.count } : {}),
                ...(judgeRetry.count ? { judge_retries: judgeRetry.count } : {}) }
            : c.meta,
          model: run.model, usage: run.usage, stop_reason: run.stop_reason,
          // This flow always scores graded runs (see header): status "ok"
          // unless runCase ever reports otherwise.
          status: run.status ?? (run.stop_reason === 'max_tokens' ? 'truncated' : 'ok'),
          judge_model: g.judge_model ?? run.judge_model,
          judge_usage: g.judge_usage ?? run.judge_usage,
          latency_s, ...perfFrom(run),
          grade: g.grade, explanation: g.explanation,
        };
        appendFileNoFollow(resultsPath, JSON.stringify(row) + '\n');
        rowWritten = true; // past this point the attempt is scored - a later throw (trace write, ref freeze) must not also append an error row
        if (run.transcript)
          writeFileNoFollow(join(vdir, 'traces', `${safeId}_rep${rep}.json`),
            JSON.stringify(run.transcript, null, 2));
        // For pairwise: on the baseline run, freeze the reference output once.
        if (args.variant === 'baseline' && run.output != null
            && !REF_EXTS.some(ext => lexists(join(refDir, safeId) + ext))) {
          mkdirNoFollow(refDir);
          writeFileNoFollow(join(refDir, safeId),
            typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        }
        ok++;
      } catch (e) {
        fail++;
        if (rowWritten) {
          // The attempt scored; only a post-row write (trace, ref) failed. An error
          // row here would double-count the billed usage under the budget rule.
          eprint(`  [${args.variant}] ${c.id} rep${rep} scored, but a post-row write failed: ${e?.message || e}`);
          continue;
        }
        // Failed attempts are data too - but they must not occupy the (case, rep)
        // slot in results.jsonl, or resume would never re-run them.
        appendFileNoFollow(errorsPath, JSON.stringify({
          prompt_id: safeId, rep,
          ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
          failure_class: e?.failure_class ?? 'error',
          error: String(e?.message || e),
          retries: appRetry.count, judge_retries: judgeRetry.count,
          // Billed-but-failed spend stays countable: when the app call completed
          // before the failure (e.g. a served-model mismatch, a judge-stage
          // ceiling), carry its identity and usage on the error row.
          model: lastRun?.model, usage: lastRun?.usage,
          judge_model: e?.judge_model ?? lastRun?.judge_model,
          judge_usage: e?.judge_usage ?? lastRun?.judge_usage,
          latency_s: (Date.now() - t0) / 1000,
        }) + '\n');
        eprint(`  [${args.variant}] ${c.id} rep${rep} FAILED: ${e?.message || e}`);
      }
    }
  }
  // One progress line every 30s (and to <vdir>/progress.txt) so "how far along
  // is it?" is answerable from the background shell's output or one file read,
  // without the orchestrator parsing results.jsonl mid-write. ETA is a plain
  // rate extrapolation from this pass.
  const t0 = Date.now();
  const progress = () => {
    const done = ok + fail, total = tasks.length;
    const el = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((el / done) * (total - done)) : null;
    const line = `[${args.variant}] ${done}/${total} done (${ok} ok, ${fail} failed), `
      + `${Math.round(el)}s elapsed` + (eta != null ? `, ~${eta}s left` : '');
    eprint(line);
    try { writeFileNoFollow(join(vdir, 'progress.txt'), line + '\n'); } catch {}
  };
  const tick = setInterval(progress, 30_000);
  workersStarted = true;
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  clearInterval(tick); progress();
  eprint(`[${args.variant}] done - ${ok} ok, ${fail} failed -> ${resultsPath}`);
  process.exit(fail ? 1 : 0);
}

// Anything main() throws prints as one sanitized line, not a raw stack. Before
// the workers start it is a refusal (a planted link at _state.json or
// results.jsonl, an lstat that fails, an error from loadCases) and exits 2 like
// the preflight refusals. After they start, only a failed errors.jsonl append
// gets here; rows may already be on disk, so say that and exit 1.
let workersStarted = false;
main().catch(e => {
  const m = String(e?.message || e);
  if (workersStarted) { eprint('stopped mid-run (rows already written are kept; re-run to resume): ' + m); process.exit(1); }
  eprint(m.startsWith('refusing to ') ? m : 'refusing to run: ' + m);
  process.exit(2);
});
