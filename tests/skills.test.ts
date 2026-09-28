import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { RunRepo } from "../src/storage/repos/runs.js";
import { TraceEventRepo } from "../src/storage/repos/trace-events.js";
import { PatternRepo } from "../src/storage/repos/patterns.js";
import { SkillCandidateRepo } from "../src/storage/repos/candidates.js";
import { extractRunToolTrace, minePatterns, MIN_PATTERN_SUPPORT, minePatternsFromDb, patternId } from "../src/learning/miner.js";
import { draftSkillFromPattern } from "../src/learning/candidate.js";
import { judgeRun, loadTaskSet, readBackVerified, renderEvalReport, runEvalAgainstBaseline, runEvalArm, runEvalComparison, type EvalRunner } from "../src/learning/eval.js";
import { promoteCandidate } from "../src/skills/promote.js";
import { SkillIndex } from "../src/skills/retrieve.js";
import { verifyPromotedSkills } from "../src/skills/verify.js";
import { parseSkillMd, serializeSkillMd, validateSkillName, SKILL_DESCRIPTION_MAX } from "../src/skills/format.js";
import { EvalBaselineRepo, SkillEvalRepo, skillEvalRowFromReport } from "../src/storage/repos/evals.js";
import { buildJudgePrompt, isInfraFailure, parseJudgeVerdictStrict, type EvalRawRun, type JudgeFn } from "../src/learning/eval.js";
import { RunManager, type SkillInjection } from "../src/runtime/run-manager.js";
import { CollectingReporter } from "../src/runtime/reporter.js";
import { assistantMessage, FAKE_MODEL, makeTempCwd, scriptedStreamFn } from "./helpers.js";
import type { TraceEvent } from "../src/trace/schema.js";

const tmp = makeTempCwd();

beforeAll(() => tmp.enter());
afterAll(() => tmp.leave());

// ---------- seeding helpers ----------

let seqCounter = 0;

function toolResultMessage(toolName: string, isError: boolean, text: string) {
  seqCounter += 1;
  return {
    role: "toolResult",
    toolCallId: `call-${seqCounter}`,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function appendToolResults(db: ReturnType<typeof openDatabase>, runId: string, results: ReturnType<typeof toolResultMessage>[]) {
  const repo = new TraceEventRepo(db);
  for (const message of results) {
    seqCounter += 1;
    const event = { v: 1, seq: seqCounter, ts: new Date().toISOString(), runId, type: "message_end", message } as unknown as TraceEvent;
    repo.append(event);
  }
}

function seedRun(db: ReturnType<typeof openDatabase>, runId: string, task: string, results: ReturnType<typeof toolResultMessage>[]) {
  new RunRepo(db).insert({ id: runId, task, modelSpec: "test/fake-model", status: "completed", startedAt: new Date().toISOString() });
  appendToolResults(db, runId, results);
}

const SKILL_JSON = {
  name: "note-file-workflow",
  description: "Create a note file by writing it and verifying the content by reading it back.",
  body: "# Note file workflow\n\n1. write_file the note\n2. read_file it back to verify",
};

// ---------- format ----------

describe("skill format (pi-compatible SKILL.md)", () => {
  it("round-trips name/description/body", () => {
    const raw = serializeSkillMd(SKILL_JSON);
    expect(raw.startsWith("---")).toBe(true);
    expect(parseSkillMd(raw, "test")).toEqual(SKILL_JSON);
  });

  it("rejects invalid names and over-long descriptions", () => {
    expect(() => validateSkillName("Note_File")).toThrow();
    expect(() => validateSkillName("a".repeat(65))).toThrow();
    expect(() => serializeSkillMd({ ...SKILL_JSON, name: "Bad Name" })).toThrow();
    expect(() => serializeSkillMd({ ...SKILL_JSON, description: "x".repeat(SKILL_DESCRIPTION_MAX + 1) })).toThrow();
    expect(() => serializeSkillMd({ ...SKILL_JSON, description: "  " })).toThrow();
  });
});

// ---------- miner ----------

describe("pattern miner (阶段 10)", () => {
  it("requires ≥3 distinct runs before a pattern exists", () => {
    const calls = [{ toolName: "write_file", isError: false }, { toolName: "read_file", isError: false }];
    const runs = ["r1", "r2"].map((runId) => ({ runId, task: "t", status: "completed", calls }));
    expect(minePatterns(runs)).toEqual([]);
    expect(minePatterns([...runs, { runId: "r3", task: "t", status: "completed", calls }])).toEqual([
      {
        id: patternId("tool-sequence", "write_file>read_file"),
        kind: "tool-sequence",
        signature: "write_file>read_file",
        support: 3,
        traceRefs: ["r1", "r2", "r3"],
        replaySafety: "unknown",
      },
    ]);
  });

  it("classifies patterns by tool replay safety (阶段 12 pattern-aware idempotency)", () => {
    const calls = (a: string, b: string) => [{ toolName: a, isError: false }, { toolName: b, isError: false }];
    const runs = ["r1", "r2", "r3"].map((runId) => ({ runId, task: "t", status: "completed", calls: calls("send_notification", "read_file") }));
    const replay = { send_notification: "never", read_file: "safe", write_file: "safe" };
    const mined = minePatterns(runs, { toolReplay: replay });
    expect(mined.map((p) => [p.signature, p.replaySafety])).toEqual([["send_notification>read_file", "contains-never"]]);
    // without a map the classification stays unknown
    expect(minePatterns(runs)[0]?.replaySafety).toBe("unknown");
    // error-repair patterns classify the repaired tool only
    const repairRuns = ["a", "b", "c"].map((runId) => ({
      runId,
      task: "t",
      status: "completed",
      calls: [
        { toolName: "send_notification", isError: true },
        { toolName: "send_notification", isError: false },
      ],
    }));
    expect(minePatterns(repairRuns, { toolReplay: replay })).toEqual([
      {
        id: patternId("error-repair", "repair:send_notification"),
        kind: "error-repair",
        signature: "repair:send_notification",
        support: 3,
        traceRefs: ["a", "b", "c"],
        replaySafety: "contains-never",
      },
    ]);
  });

  it("refuses to lower the support floor below MIN_PATTERN_SUPPORT", () => {
    expect(() => minePatterns([], { minSupport: MIN_PATTERN_SUPPORT - 1 })).toThrow(/hard floor/);
    expect(MIN_PATTERN_SUPPORT).toBe(3);
  });

  it("skips repetition n-grams and counts each run once per signature", () => {
    const call = { toolName: "read_file", isError: false };
    const runs = ["a", "b", "c"].map((runId) => ({
      runId,
      task: "t",
      status: "completed",
      calls: [call, call, call], // read_file>read_file everywhere — repetition, not workflow
    }));
    expect(minePatterns(runs)).toEqual([]);
  });

  it("finds error→repair pairs across runs", () => {
    const mk = (): ReturnType<typeof toolResultMessage>[] => [
      toolResultMessage("write_file", true, "ENOENT: no such directory"),
      toolResultMessage("write_file", false, "wrote"),
    ];
    const runs = ["a", "b", "c"].map((runId) => ({ runId, task: "t", status: "completed", calls: mk().map((m) => ({ toolName: m.toolName, isError: Boolean(m.isError), errorText: m.isError ? m.content[0].text : undefined })) }));
    const mined = minePatterns(runs);
    const repair = mined.find((p) => p.kind === "error-repair");
    expect(repair).toMatchObject({ signature: "repair:write_file", support: 3 });
  });

  it("extracts run tool traces from message_end events (errorText captured)", () => {
    const db = openDatabase(path.join(tmp.dir, "extract", "harness.db"));
    try {
      seedRun(db, "rx", "task with error", [toolResultMessage("write_file", true, "boom"), toolResultMessage("read_file", false, "ok")]);
      const runRow = new RunRepo(db).get("rx")!;
      const trace = extractRunToolTrace(runRow, new TraceEventRepo(db).getByRun("rx"));
      expect(trace.calls).toEqual([
        { toolName: "write_file", isError: true, errorText: "boom" },
        { toolName: "read_file", isError: false, errorText: undefined },
      ]);
    } finally {
      db.close();
    }
  });
});

// ---------- candidate ----------

describe("skill candidate (hard support gate + distillation)", () => {
  it("refuses to draft from a pattern below the support floor (single-run ban is code, not policy)", async () => {
    const dbPath = path.join(tmp.dir, "gate", "harness.db");
    const db = openDatabase(dbPath);
    try {
      new PatternRepo(db).replaceAll([
        { id: "weak-pattern", kind: "tool-sequence", signature: "write_file>read_file", support: 2, traceRefs: ["r1", "r2"] },
      ]);
      await expect(draftSkillFromPattern("weak-pattern", { database: dbPath, complete: async () => JSON.stringify(SKILL_JSON) })).rejects.toThrow(
        /support 2 < 3/,
      );
    } finally {
      db.close();
    }
  });

  it("drafts from a support≥3 pattern and records provenance", async () => {
    const dbPath = path.join(tmp.dir, "draft", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const [i, topic] of ["fruits", "veggies", "metals"].entries()) {
        seedRun(db, `seed-${i}`, `create a note file about ${topic}`, [
          toolResultMessage("write_file", false, "wrote"),
          toolResultMessage("read_file", false, "ok"),
        ]);
      }
      const drafts = minePatternsFromDb(db);
      expect(drafts.length).toBeGreaterThan(0);
      new PatternRepo(db).replaceAll(drafts);
      patternIdValue = drafts[0]!.id;
    } finally {
      db.close();
    }
    const outcome = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify(SKILL_JSON),
      skillsRoot: path.join(tmp.dir, "draft", "skills"),
    });
    expect(outcome.method).toBe("llm");
    expect(outcome.candidate.status).toBe("draft");
    expect(outcome.candidate.provenance).toMatchObject({
      patternId: patternIdValue,
      patternSignature: "write_file>read_file",
      support: 3,
      runIds: ["seed-0", "seed-1", "seed-2"],
    });
    const raw = fs.readFileSync(outcome.file, "utf8");
    expect(parseSkillMd(raw, outcome.file)).toEqual(SKILL_JSON);
  });

  it("falls back to a mechanical draft when the LLM pipeline fails, keeping the loop unbroken", async () => {
    const dbPath = path.join(tmp.dir, "fallback", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const i of [0, 1, 2]) {
        seedRun(db, `fb-${i}`, `task ${i}`, [toolResultMessage("write_file", false, "wrote"), toolResultMessage("read_file", false, "ok")]);
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternIdValue = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const outcome = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => "not json at all", // structured pipeline exhausts → fallback
      skillsRoot: path.join(tmp.dir, "fallback", "skills"),
    });
    expect(outcome.method).toBe("fallback");
    expect(parseSkillMd(fs.readFileSync(outcome.file, "utf8"), outcome.file).name).toContain("workflow-write-file");
  });
});

// ---------- promote + retrieve ----------

describe("promotion + retrieval (阶段 10)", () => {
  it("promotes a candidate to the pi-compatible layout and indexes it", async () => {
    const dbPath = path.join(tmp.dir, "promote", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const i of [0, 1, 2]) {
        seedRun(db, `p-${i}`, `note file task ${i}`, [toolResultMessage("write_file", false, "wrote"), toolResultMessage("read_file", false, "ok")]);
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternIdValue = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const skillsRoot = path.join(tmp.dir, "promote", "skills");
    const draft = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify(SKILL_JSON),
      skillsRoot,
    });
    const promoted = promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot });
    expect(promoted.skillMdPath).toBe(path.join(skillsRoot, "promoted", SKILL_JSON.name, "SKILL.md"));
    expect(fs.existsSync(promoted.skillMdPath)).toBe(true);

    const db2 = openDatabase(dbPath);
    try {
      const index = new SkillIndex(db2);
      expect(index.count()).toBe(1);
      expect(index.search("create a note file", 2)[0]?.name).toBe(SKILL_JSON.name);

      const candidate = new SkillCandidateRepo(db2).get(draft.candidate.id);
      expect(candidate?.status).toBe("promoted");

      // promote again → rejected; duplicate name → needs force
      expect(() => promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot })).toThrow(/already promoted/);

      // a second draft with the same name needs --force
      const draft2 = await draftSkillFromPattern(patternIdValue, {
        database: dbPath,
        complete: async () => JSON.stringify(SKILL_JSON),
        skillsRoot,
      });
      expect(() => promoteCandidate(draft2.candidate.id, { database: dbPath, skillsRoot })).toThrow(/already exists/);
      const forced = promoteCandidate(draft2.candidate.id, { database: dbPath, skillsRoot, force: true });
      expect(forced.overwritten).toBe(true);
      expect(forced.skill.version).toBe(2);

      // derived index survives a wipe via rebuild from the authoritative files
      index.rebuild(path.join(skillsRoot, "promoted"));
      expect(index.count()).toBe(1);
      expect(index.search("note file", 2)[0]?.version).toBe(2);
    } finally {
      db2.close();
    }
  });

  it("verification: the promoted root loads through pi's own loadSkillsFromDir (consumer contract)", async () => {
    const dbPath = path.join(tmp.dir, "verify", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const i of [0, 1, 2]) {
        seedRun(db, `v-${i}`, `note file task ${i}`, [toolResultMessage("write_file", false, "wrote"), toolResultMessage("read_file", false, "ok")]);
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternIdValue = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const skillsRoot = path.join(tmp.dir, "verify", "skills");
    const draft = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify(SKILL_JSON),
      skillsRoot,
    });
    promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot });
    const verification = verifyPromotedSkills(path.join(skillsRoot, "promoted"));
    expect(verification.ok).toBe(true);
    expect(verification.skills.map((s) => s.name)).toContain(SKILL_JSON.name);
  });

  it("promote gate: refuses a skill whose latest valid report says baseline-wins (--force overrides)", async () => {
    const dbPath = path.join(tmp.dir, "gate2", "harness.db");
    const db = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      for (const i of [0, 1, 2]) {
        seedRun(db, `g-${i}`, `note file task ${i}`, [toolResultMessage("write_file", false, "wrote"), toolResultMessage("read_file", false, "ok")]);
      }
      new PatternRepo(db).replaceAll(minePatternsFromDb(db));
      patternIdValue = new PatternRepo(db).list()[0]!.id;
    } finally {
      db.close();
    }
    const skillsRoot = path.join(tmp.dir, "gate2", "skills");
    const draft = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify(SKILL_JSON),
      skillsRoot,
    });

    // a VALID report that lost to the baseline → promote refused
    const db2 = openDatabase(dbPath);
    try {
      new SkillEvalRepo(db2).insert({
        id: "report-loser",
        skillName: SKILL_JSON.name,
        evalSet: "file-creation-v1",
        repeats: 3,
        baselinePass: 1,
        candidatePass: 0.5,
        verdict: "baseline-wins",
        cost: {
          baseline: { totalTokens: 0, totalDurationMs: 0, avgTokens: 0, avgDurationMs: 0 },
          treatment: { totalTokens: 0, totalDurationMs: 0, avgTokens: 0, avgDurationMs: 0 },
        },
        report: { taskSet: "file-creation-v1", skill: SKILL_JSON.name, repeats: 3, baselineSource: "fresh", valid: true, verdict: "baseline-wins", baseline: { arm: "baseline", results: [], taskSummaries: [], passRate: 1, verifiedRuns: 0, infraFailures: 0, totalTokens: 0, totalDurationMs: 0 }, treatment: { arm: "treatment", results: [], taskSummaries: [], passRate: 0.5, verifiedRuns: 0, infraFailures: 0, totalTokens: 0, totalDurationMs: 0 }, decidedAt: new Date().toISOString() } as never,
        decidedAt: new Date().toISOString(),
      });
    } finally {
      db2.close();
    }
    expect(() => promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot })).toThrow(/eval gate/);
    // force overrides the gate
    const forced = promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot, force: true });
    expect(forced.skill.name).toBe(SKILL_JSON.name);
  });
});

// ---------- run injection ----------

describe("skill injection into runs (阶段 10)", () => {
  async function runWithSkills(dbPath: string, skills: SkillInjection | false) {
    const manager = new RunManager();
    try {
      return await manager.run({
        task: "create a note file about spices",
        model: FAKE_MODEL,
        streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "ok" }], "stop")]),
        reporter: new CollectingReporter(),
        database: dbPath,
        tools: [],
        skills,
      });
    } finally {
      manager.close();
    }
  }

  it("injects matching promoted skills as <available_skills> and honors skills:false", async () => {
    const dbPath = path.join(tmp.dir, "inject", "harness.db");
    const db = openDatabase(dbPath);
    const skillsRoot = path.join(tmp.dir, "inject", "skills");
    try {
      const dirPath = path.join(skillsRoot, "promoted", SKILL_JSON.name);
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, "SKILL.md"), serializeSkillMd(SKILL_JSON), "utf8");
      new SkillIndex(db).syncSkill({ name: SKILL_JSON.name, dirPath, description: SKILL_JSON.description, body: SKILL_JSON.body });
    } finally {
      db.close();
    }

    const withSkill = await runWithSkills(dbPath, undefined);
    expect(withSkill.record.systemPrompt).toContain("<available_skills>");
    expect(withSkill.record.systemPrompt).toContain(SKILL_JSON.name);
    expect(withSkill.record.systemPrompt).toContain(path.join("inject", "skills", "promoted", SKILL_JSON.name, "SKILL.md"));

    const withoutSkill = await runWithSkills(dbPath, false);
    expect(withoutSkill.record.systemPrompt).not.toContain("<available_skills>");

    // forced injection: hits even when FTS would miss
    const forced = await runWithSkills(dbPath, { only: [SKILL_JSON.name] });
    expect(forced.record.systemPrompt).toContain(`<name>${SKILL_JSON.name}</name>`);
  });
});

// ---------- eval ----------

describe("scripted A/B eval (阶段 10)", () => {
  it("judges deterministically: completion + expected artifact checks", () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "out.md"), "apples and pears", "utf8");
    const base = { taskId: "t1", status: "completed", tokens: 10 };
    expect(judgeRun({ id: "t1", task: "x" }, base).pass).toBe(true);
    expect(judgeRun({ id: "t1", task: "x" }, { ...base, status: "failed", error: "boom" }).reason).toContain("failed");
    expect(judgeRun({ id: "t1", task: "x", expectFile: "missing.md" }, base).reason).toContain("missing");
    expect(judgeRun({ id: "t1", task: "x", expectFile: "out.md", expectContains: "banana" }, base).reason).toContain("banana");
    expect(judgeRun({ id: "t1", task: "x", expectFile: "out.md", expectContains: "apples" }, base).pass).toBe(true);
    tmp.leave();
  });

  it("judges v2 checks: line count, exact lines, uniqueness, sorting, per-line regex", () => {
    tmp.enter();
    const write = (name: string, content: string) => fs.writeFileSync(path.join(tmp.dir, name), content, "utf8");
    const ok = { taskId: "t", status: "completed" };
    // line count
    write("five.txt", "a\nb\nc\nd\ne\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "five.txt", expectLines: 5 }, ok).pass).toBe(true);
    expect(judgeRun({ id: "t", task: "x", expectFile: "five.txt", expectLines: 6 }, ok).reason).toContain("expected 6");
    // exact lines (order-sensitive)
    write("words.txt", "alpha\nbeta\ngamma\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "words.txt", expectLinesExact: ["alpha", "beta", "gamma"] }, ok).pass).toBe(true);
    expect(judgeRun({ id: "t", task: "x", expectFile: "words.txt", expectLinesExact: ["alpha", "gamma", "beta"] }, ok).reason).toContain("line 2");
    // uniqueness
    write("dup.txt", "a\nb\na\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "dup.txt", expectUnique: true }, ok).reason).toContain("duplicate");
    // sorting (case-insensitive)
    write("sorted.txt", "ant\nBee\ncow\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "sorted.txt", expectSorted: true }, ok).pass).toBe(true);
    write("unsorted.txt", "cow\nant\nbee\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "unsorted.txt", expectSorted: true }, ok).reason).toContain("alphabetical");
    // descending order
    write("desc.txt", "cow\nBee\nant\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "desc.txt", expectSorted: "desc" }, ok).pass).toBe(true);
    write("asc.txt", "ant\nBee\ncow\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "asc.txt", expectSorted: "desc" }, ok).reason).toContain("reverse");
    // per-line regex
    write("nums.txt", "item-1\nitem-2\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "nums.txt", expectLineRegex: "^item-\\d+$" }, ok).pass).toBe(true);
    write("bad.txt", "item-1\nitem two\n");
    expect(judgeRun({ id: "t", task: "x", expectFile: "bad.txt", expectLineRegex: "^item-\\d+$" }, ok).reason).toContain("item two");
    tmp.leave();
  });

  it("resets the workspace before every run: fixtures rewritten, stale artifacts removed", async () => {
    tmp.enter();
    const seen: string[] = [];
    const taskSet = {
      name: "fixture",
      tasks: [
        {
          id: "update",
          task: "make pantry.txt contain exactly flour, sugar",
          setupFiles: { "pantry.txt": "flour\nsugar\n" },
          expectFile: "pantry.txt",
        },
      ],
    };
    const mutatingRunner: EvalRunner = async (task) => {
      seen.push(fs.readFileSync(path.join(tmp.dir, "pantry.txt"), "utf8"));
      // simulate the model rewriting the file (as a real run would)
      fs.writeFileSync(path.join(tmp.dir, "pantry.txt"), "flour\nsugar\nsalt\npepper\n", "utf8");
      return { taskId: task.id, status: "completed" };
    };
    const arm = await runEvalArm(taskSet, mutatingRunner, false, { repeats: 2 });
    // both repeats saw the pristine fixture — the second did not inherit run 1's rewrite
    expect(seen).toEqual(["flour\nsugar\n", "flour\nsugar\n"]);
    expect(arm.taskSummaries).toEqual([{ taskId: "update", passes: 2, repeats: 2, failures: [] }]);
    // stale artifact from the previous run is removed before the next one
    fs.writeFileSync(path.join(tmp.dir, "art.txt"), "old", "utf8");
    let existedDuringPrepare = false;
    const probingRunner: EvalRunner = async (task) => {
      existedDuringPrepare = fs.existsSync(path.join(tmp.dir, "art.txt"));
      return { taskId: task.id, status: "completed" };
    };
    await runEvalArm({ name: "s", tasks: [{ id: "a", task: "x", expectFile: "art.txt" }] }, probingRunner, false);    expect(existedDuringPrepare).toBe(false);
    tmp.leave();
  });

  it("aggregates repeats into per-task summaries and an honest verdict", async () => {
    const taskSet = {
      name: "notes",
      tasks: [
        { id: "t1", task: "note one" },
        { id: "t2", task: "note two" },
      ],
    };
    // baseline passes t1 always and t2 once in two repeats; treatment passes everything
    let t2Calls = 0;
    const runner: EvalRunner = async (task, skills) => {
      const failBaseline = skills === false && task.id === "t2" && ++t2Calls % 2 === 1;
      return { taskId: task.id, status: failBaseline ? "failed" : "completed", tokens: 5 };
    };
    const report = await runEvalComparison(taskSet, { runner, skillName: "note-file-workflow", repeats: 2 });
    expect(report.repeats).toBe(2);
    expect(report.baseline.results).toHaveLength(4);
    expect(report.baseline.passRate).toBe(3 / 4);
    expect(report.treatment.passRate).toBe(1);
    expect(report.verdict).toBe("candidate-wins");
    const rendered = renderEvalReport(report);
    expect(rendered).toContain("t1: 2/2 vs 2/2");
    expect(rendered).toContain("t2: 1/2 vs 2/2");
    expect(rendered).toContain("candidate-wins");

    const reversed = await runEvalComparison(taskSet, {
      runner: async (task, skills) => ({ taskId: task.id, status: skills !== false && task.id === "t1" ? "failed" : "completed" }),
      skillName: "note-file-workflow",
    });
    expect(reversed.verdict).toBe("baseline-wins");
  });

  it("detects read-back verification from the transcript", () => {
    const toolCall = (name: string, path: string) => ({ type: "toolCall" as const, id: name + path, name, arguments: { path } });
    const assistant = (...calls: ReturnType<typeof toolCall>[]) =>
      ({ role: "assistant", content: calls, stopReason: "toolUse", timestamp: 1 }) as never;
    // write then read the same path → verified
    expect(readBackVerified([assistant(toolCall("write_file", "a.txt")), assistant(toolCall("read_file", "a.txt"))])).toBe(true);
    // read before any write → not verified
    expect(readBackVerified([assistant(toolCall("read_file", "a.txt")), assistant(toolCall("write_file", "a.txt"))])).toBe(false);
    // read of a different path → not verified
    expect(readBackVerified([assistant(toolCall("write_file", "a.txt")), assistant(toolCall("read_file", "b.txt"))])).toBe(false);
    // reading the injected skill file is not a read-back
    expect(readBackVerified([assistant(toolCall("read_file", ".harness/skills/promoted/s/SKILL.md")), assistant(toolCall("write_file", "a.txt"))])).toBe(false);
    // multiple writes, read-back of the second → verified
    expect(
      readBackVerified([assistant(toolCall("write_file", "a.txt")), assistant(toolCall("write_file", "b.txt")), assistant(toolCall("read_file", "b.txt"))]),
    ).toBe(true);
    expect(readBackVerified([])).toBe(false);
  });

  it("loads and validates task sets", () => {
    tmp.enter();
    const file = path.join(tmp.dir, "taskset.json");
    fs.writeFileSync(file, JSON.stringify({ name: "set", tasks: [{ id: "a", task: "do", expectFile: "out.txt" }] }), "utf8");
    expect(loadTaskSet(file).tasks).toHaveLength(1);
    fs.writeFileSync(file, JSON.stringify({ name: "set", tasks: [] }), "utf8");
    expect(() => loadTaskSet(file)).toThrow();
    tmp.leave();
  });
});

// ---------- E2E: the completion standard, in-process ----------

describe("全链路：3 条相似 trace → pattern → candidate → promote → 新任务自动注入", () => {
  it("runs the closed loop end-to-end without a single API call", async () => {
    const dbPath = path.join(tmp.dir, "e2e", "harness.db");
    const skillsRoot = path.join(tmp.dir, "e2e", "skills");

    // 1. three similar runs land in trace storage
    const db = openDatabase(dbPath);
    try {
      for (const [i, topic] of ["fruits", "veggies", "metals"].entries()) {
        seedRun(db, `e2e-${i}`, `create a note file about ${topic}`, [
          toolResultMessage("write_file", false, "wrote"),
          toolResultMessage("read_file", false, "verified"),
        ]);
      }
    } finally {
      db.close();
    }

    // 2. mine → only support≥3 patterns survive
    const db2 = openDatabase(dbPath);
    let patternIdValue = "";
    try {
      const repo = new PatternRepo(db2);
      repo.replaceAll(minePatternsFromDb(db2));
      const patterns = repo.list();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.every((p) => p.support >= MIN_PATTERN_SUPPORT)).toBe(true);
      patternIdValue = patterns[0]!.id;
    } finally {
      db2.close();
    }

    // 3. distill (fake chat) → 4. promote
    const draft = await draftSkillFromPattern(patternIdValue, {
      database: dbPath,
      complete: async () => JSON.stringify(SKILL_JSON),
      skillsRoot,
    });
    const promoted = promoteCandidate(draft.candidate.id, { database: dbPath, skillsRoot });
    expect(promoted.skill.name).toBe(SKILL_JSON.name);

    // 5. a NEW task automatically sees the skill in its system prompt
    const manager = new RunManager();
    const result = await manager.run({
      task: "create a note file about spices",
      model: FAKE_MODEL,
      streamFn: scriptedStreamFn([assistantMessage([{ type: "text", text: "done" }], "stop")]),
      reporter: new CollectingReporter(),
      database: dbPath,
      tools: [],
    });
    manager.close();
    expect(result.record.status).toBe("completed");
    expect(result.record.systemPrompt).toContain("<available_skills>");
    expect(result.record.systemPrompt).toContain(SKILL_JSON.name);
  });
});

// ---------- 阶段 11: LLM judge, persistence, regression baseline ----------

describe("LLM judge (deterministic first, judge second)", () => {
  it("judge verdict parses strictly", () => {
    expect(parseJudgeVerdictStrict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: "ok" });
    expect(() => parseJudgeVerdictStrict("no json")).toThrow();
    expect(() => parseJudgeVerdictStrict('{"reason": "no pass field"}')).toThrow();
  });

  it("deterministic failure short-circuits — the judge is never called", async () => {
    tmp.enter();
    let judgeCalls = 0;
    const judge: JudgeFn = async () => {
      judgeCalls++;
      return { pass: false, reason: "judge says no" };
    };
    const arm = await runEvalArm(
      { name: "s", tasks: [{ id: "t", task: "x", expectFile: "missing.txt", judgeInstructions: "be good" }] },
      async (task) => ({ taskId: task.id, status: "completed" }),
      false,
      { judge },
    );
    expect(judgeCalls).toBe(0);
    expect(arm.results[0]?.pass).toBe(false);
    expect(arm.results[0]?.reason).toContain("missing");
    tmp.leave();
  });

  it("judge decides when deterministic checks pass, and is skipped without judgeInstructions", async () => {
    tmp.enter();
    fs.writeFileSync(path.join(tmp.dir, "ok.txt"), "content", "utf8");
    let judgeCalls = 0;
    const judge: JudgeFn = async (input) => {
      judgeCalls++;
      expect(input.judgeInstructions).toContain("mention the tradeoff");
      expect(input.finalText).toContain("here is my answer");
      return { pass: false, reason: "does not mention the tradeoff" };
    };
    const taskSet = {
      name: "s",
      tasks: [
        { id: "judged", task: "answer", expectFile: "ok.txt", judgeInstructions: "must mention the tradeoff" },
        { id: "plain", task: "answer", expectFile: "ok.txt" },
      ],
    };
    const arm = await runEvalArm(
      taskSet,
      async (task) => {
        // the "model" creates its artifact — prepareTaskWorkspace deleted it beforehand
        fs.writeFileSync(path.join(tmp.dir, "ok.txt"), "content", "utf8");
        return { taskId: task.id, status: "completed", finalText: "here is my answer" };
      },
      false,
      { judge },
    );
    expect(judgeCalls).toBe(1); // only the task with judgeInstructions
    const judged = arm.results.find((r) => r.taskId === "judged")!;
    const plain = arm.results.find((r) => r.taskId === "plain")!;
    expect(judged.pass).toBe(false);
    expect(judged.reason).toContain("tradeoff");
    expect(plain.pass).toBe(true);
    tmp.leave();
  });

  it("judge prompt carries task, instructions and final text", () => {
    const prompt = buildJudgePrompt({ task: "do x", judgeInstructions: "check y", finalText: "my answer", status: "completed" });
    expect(prompt).toContain("do x");
    expect(prompt).toContain("check y");
    expect(prompt).toContain("my answer");
  });

  it("marks infrastructure failures (rate limit/quota/auth) and invalidates the report", async () => {
    tmp.enter();
    const rateLimited: EvalRawRun = { taskId: "t", status: "failed", error: '429: {"message":"Rate limit exceeded: free-models-per-day"}' };
    expect(isInfraFailure(rateLimited)).toBe(true);
    // Aliyun wraps out-of-credit as HTTP 400 + Arrearage (阶段 14 live finding)
    expect(
      isInfraFailure({
        taskId: "t",
        status: "failed",
        error: 'run failed: 400: {"message":"Access denied, please make sure your account is in good standing.","type":"Arrearage","code":"Arrearage"}',
      }),
    ).toBe(true);
    // a bare 400 without business-code words is a normal bad request, not infra
    expect(isInfraFailure({ taskId: "t", status: "failed", error: '400: {"error":"invalid arguments"}' })).toBe(false);
    expect(isInfraFailure({ taskId: "t", status: "failed", error: "ENOSPC: no space left" })).toBe(false);
    expect(isInfraFailure({ taskId: "t", status: "completed" })).toBe(false);
    const judged = judgeRun({ id: "t", task: "x" }, rateLimited);
    expect(judged.pass).toBe(false);
    expect(judged.infra).toBe(true);

    // one infra failure in an arm → the report stays numerically computed but is INVALID for gating
    let call = 0;
    const flakyRunner: EvalRunner = async (task) => {
      call++;
      if (call === 1) return rateLimited;
      return { taskId: task.id, status: "completed", tokens: 5 };
    };
    const report = await runEvalComparison({ name: "s", tasks: [{ id: "t1", task: "x" }, { id: "t2", task: "x" }] }, {
      runner: flakyRunner,
      skillName: "some-skill",
    });
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toContain("infrastructure");
    expect(report.baseline.infraFailures).toBe(1);
    const rendered = renderEvalReport(report);
    expect(rendered).toContain("⚠ INVALID REPORT");
    expect(rendered).toContain("INVALID — do not use for gating");
    tmp.leave();
  });
});

describe("eval persistence + regression baseline (阶段 11)", () => {
  it("persists reports and baselines; against-baseline reuses the stored arm", async () => {
    const dbPath = path.join(tmp.dir, "evaldb", "harness.db");
    const db = openDatabase(dbPath);
    try {
      const taskSet = { name: "set-x", tasks: [{ id: "t1", task: "x" }] };
      const runner: EvalRunner = async (task) => ({ taskId: task.id, status: "completed", tokens: 10, durationMs: 5 });

      // record a baseline (2 repeats → 2 runs), latest() returns it
      const baselineArm = await runEvalArm(taskSet, runner, false, { repeats: 2 });
      const baseline = new EvalBaselineRepo(db).record({ evalSet: taskSet.name, modelSpec: "test/model", repeats: 2, arm: baselineArm });
      expect(new EvalBaselineRepo(db).latest(taskSet.name, "test/model")?.id).toBe(baseline.id);
      expect(new EvalBaselineRepo(db).latest("other", "test/model")).toBeUndefined();

      // full A/B report → persist → list
      const report = await runEvalComparison(taskSet, { runner, skillName: "some-skill", repeats: 2 });
      const row = skillEvalRowFromReport(report, "candidate-1");
      new SkillEvalRepo(db).insert(row);
      const listed = new SkillEvalRepo(db).list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        skillName: "some-skill",
        sourceCandidateId: "candidate-1",
        evalSet: "set-x",
        repeats: 2,
        verdict: "tie",
        baselinePass: 1,
        candidatePass: 1,
      });
      expect(listed[0]?.report.baselineSource).toBe("fresh");
      expect(listed[0]?.cost.baseline.avgTokens).toBe(10);

      // against-baseline: only the treatment arm runs; stored arm is compared
      let runnerCalls = 0;
      const countingRunner: EvalRunner = async (task, skills) => {
        runnerCalls++;
        expect(skills).toEqual({ only: ["some-skill"] }); // treatment arm only
        return { taskId: task.id, status: "completed", tokens: 10 };
      };
      const regression = await runEvalAgainstBaseline(taskSet, {
        runner: countingRunner,
        skillName: "some-skill",
        repeats: 2,
        stored: { arm: baselineArm, repeats: 2 },
      });
      expect(regression.baselineSource).toBe("stored");
      expect(regression.baseline).toEqual(baselineArm);
      expect(regression.treatment.passRate).toBe(1);
      expect(runnerCalls).toBe(2); // 1 task × 2 repeats — no baseline re-run
      expect(regression.verdict).toBe("tie");
      expect(renderEvalReport(regression)).toContain("stored");
    } finally {
      db.close();
    }
  });
});
