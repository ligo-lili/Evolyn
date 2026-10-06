// Oracle for evals/coding-compact-v1.json: every task's reference content must pass
// judgeRun and empty content must fail. Run from the repo root after a build:
//   node .claude/hillclimb/coding-tasks-compact/_tools/oracle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { judgeRun, loadTaskSet } = await import(pathToFileURL(path.join(repo, "dist", "learning", "eval.js")).href);
const set = loadTaskSet(path.join(repo, "evals", "coding-compact-v1.json"));
console.log(`set: ${set.name}, ${set.tasks.length} tasks (expect 7)`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compact-oracle-"));
process.chdir(tmp);
let ok = 0;
for (const t of set.tasks) {
  fs.writeFileSync(path.join(tmp, t.expectFile), t.expectLinesExact.join("\n") + "\n");
  const passRun = judgeRun(t, { taskId: t.id, status: "completed" });
  fs.writeFileSync(path.join(tmp, t.expectFile), "");
  const nullRun = judgeRun(t, { taskId: t.id, status: "completed" });
  const fine = passRun.pass === true && nullRun.pass === false;
  if (fine) ok++;
  console.log(`${fine ? "OK  " : "FAIL"} ${t.id}: reference=${passRun.pass}${passRun.pass ? "" : " (" + (passRun.reason ?? "").slice(0, 90) + ")"} null=${nullRun.pass}`);
}
process.chdir(repo);
fs.rmSync(tmp, { recursive: true, force: true });
// balloon size sanity: docs total estimated tokens (chars/4) should cross the ~8.2k soft line
const anyTask = set.tasks.find((t) => t.id === "recall-token");
let chars = 0;
for (const [name, content] of Object.entries(anyTask.setupFiles)) if (name.startsWith("d0")) chars += content.length;
console.log(`balloon: 8 docs = ${chars} chars ≈ ${Math.round(chars / 4)} est-tokens (soft line ~8.2k at preferenceTokens=10240)`);
process.exit(ok === set.tasks.length ? 0 : 1);
