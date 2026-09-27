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
import { judgeRun, loadTaskSet, renderEvalReport, runEvalComparison, type EvalRunner } from "../src/learning/eval.js";
import { promoteCandidate } from "../src/skills/promote.js";
import { SkillIndex } from "../src/skills/retrieve.js";
import { parseSkillMd, serializeSkillMd, validateSkillName, SKILL_DESCRIPTION_MAX } from "../src/skills/format.js";
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

  it("compares both arms and declares the verdict against the baseline", async () => {
    const taskSet = {
      name: "notes",
      tasks: [
        { id: "t1", task: "note one" },
        { id: "t2", task: "note two" },
      ],
    };
    // baseline: 1/2 pass; treatment: 2/2
    const runner: EvalRunner = async (task, skills) => ({
      taskId: task.id,
      status: skills === false && task.id === "t2" ? "failed" : "completed",
      tokens: 5,
    });
    const report = await runEvalComparison(taskSet, { runner, skillName: "note-file-workflow" });
    expect(report.baseline.passRate).toBe(0.5);
    expect(report.treatment.passRate).toBe(1);
    expect(report.verdict).toBe("candidate-wins");
    expect(renderEvalReport(report)).toContain("candidate-wins");

    const reversed = await runEvalComparison(taskSet, {
      runner: async (task, skills) => ({ taskId: task.id, status: skills !== false && task.id === "t1" ? "failed" : "completed" }),
      skillName: "note-file-workflow",
    });
    expect(reversed.verdict).toBe("baseline-wins");
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
