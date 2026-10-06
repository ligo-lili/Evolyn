// One-off generator for evals/coding-compact-v1.json (context-compaction fidelity set).
// Run from the repo root: node .claude/hillclimb/coding-tasks-compact/_tools/generate-set.mjs
// Deterministic: no randomness; regenerating reproduces the same set byte-for-byte.
import fs from "node:fs";

const firstWords = ["amber", "basil", "cedar", "dune", "ember", "fjord", "garnet", "harbor"];
const filler = [
  "The harbor ledger records arrivals under varying conditions and the clerks compare them weekly.",
  "A steady rain moved across the northern ridge while the survey team catalogued the markers.",
  "Each entry carries a reference number a short note and the initials of the officer on duty.",
  "Wind speeds were recorded at dawn and again at dusk in a narrow ruled column.",
  "The archive keeps duplicate sheets in a dry cabinet indexed by season and region.",
  "Occasionally a page is misfiled and later restored after a careful cross-check of the index.",
  "Training sessions for new clerks cover the standard abbreviations used across all ledgers.",
  "The annual summary is assembled from the monthly digests with a final review in spring.",
];
const docs = {};
const wordCounts = {};
for (let i = 0; i < 8; i++) {
  const name = `d0${i + 1}.txt`;
  const sents = [];
  for (let j = 0; j < 78; j++) {
    const src = filler[(i + j) % 8].split(" ");
    sents.push(src.slice(0, 11 + ((i * 3 + j * 5) % 9)).join(" "));
  }
  const body = firstWords[i] + " " + sents.join(" ");
  docs[name] = body + "\n";
  wordCounts[name] = body.trim().split(/\s+/).length;
}

const genJs =
  'const fs = require("node:fs");\nconst seed = fs.readFileSync("seed.txt", "utf8").trim();\nlet h = 0;\nfor (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;\nconsole.log("TOKEN-" + h.toString(16));\n';
const tok = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "TOKEN-" + h.toString(16); };

const aNums = [17, 4, 9, 23, 11];
const bNums = [6, 30, 2, 15, 8];
const T = aNums.reduce((x, y) => x + y, 0) + bNums.reduce((x, y) => x + y, 0);

const keys = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const items = keys.map((k, i) => `${k}=${(i + 3) * 11}`).join("\n") + "\n";

const spec1 =
  "Output format for every file you create from now on: name it out_<name>.txt; it must contain exactly one line of the form <NAME>:<n> - NAME in uppercase letters, n as a two-digit zero-padded integer.\n";
const xItems = Array.from({ length: 7 }, (_, i) => `item-${i + 1}`).join("\n") + "\n";
const spec2 =
  "Format for the summary file: all values sorted descending, joined with a space, pipe, space between them; the line starts with R: followed by one space.\n";
const yNums = [42, 7, 19, 88, 3];

const docsSetup = { ...docs };
const tasks = [
  {
    id: "recall-token",
    tag: "mandatory-recall",
    task: "Work in the workspace step by step. (a) Run `node gen.js` once and note the token it prints. (b) Overwrite seed.txt so it contains exactly the single line `beta`, then run `node gen.js` again and note the second token. (c) Read all eight files under docs/ (d01.txt through d08.txt). (d) Create proof.txt with exactly three lines: the FIRST token on line 1, the SECOND token on line 2, and on line 3 the first word of docs/d08.txt.",
    setupFiles: { "gen.js": genJs, "seed.txt": "alpha\n", ...docsSetup },
    expectFile: "proof.txt",
    expectLinesExact: [tok("alpha"), tok("beta"), firstWords[7]],
  },
  {
    id: "recall-tag",
    tag: "mandatory-recall",
    task: "Work step by step. (a) Read cfg.json and note its tag value. (b) Delete cfg.json. (c) Read all eight files under docs/ (d01.txt through d08.txt). (d) Create audit.txt: the first line is `tag: <the tag from cfg.json>`, followed by one line per docs file in filename order formatted `<filename>: <first word of that file>`.",
    setupFiles: { "cfg.json": '{"tag":"zulu-31"}\n', ...docsSetup },
    expectFile: "audit.txt",
    expectLinesExact: ["tag: zulu-31", ...Object.keys(docs).sort().map((n) => `${n}: ${firstWords[parseInt(n.slice(1, 3), 10) - 1]}`)],
  },
  {
    id: "fix-factor",
    tag: "mandatory-recall",
    task: "Work step by step. (a) Compute the total T = (sum of the numbers in src/a.txt) + (sum of the numbers in src/b.txt) and create first.txt containing exactly `total=<T>`. (b) Read all eight files under docs/ and create notes.txt with one line per file: `<filename> words=<word count of that file>`. (c) Correction: your earlier total is superseded - delete first.txt and create final.txt containing exactly `final=<T + 100>` where T is the total you computed in step (a).",
    setupFiles: { "src/a.txt": aNums.join("\n") + "\n", "src/b.txt": bNums.join("\n") + "\n", ...docsSetup },
    expectFile: "final.txt",
    expectLinesExact: [`final=${T + 100}`],
  },
  {
    id: "amend-rename",
    tag: "long-fidelity",
    task: "Work step by step. (a) For each line `k=v` in items.txt create a file named `k_sum.txt` containing exactly one line: the key in UPPERCASE, a colon, a space, then the value. (b) Read all eight files under docs/. (c) Amendment: the naming rule changed - rename each file you created in (a) to `<UPPERCASE KEY>_v2.txt` (e.g. the file for key `alpha` becomes `ALPHA_V2.txt`; content unchanged). (d) Create manifest.txt listing the final names of those eight files, one per line, sorted alphabetically.",
    setupFiles: { "items.txt": items, ...docsSetup },
    expectFile: "manifest.txt",
    expectLinesExact: keys.map((k) => `${k.toUpperCase()}_V2.txt`).sort(),
  },
  {
    id: "spec-early-1",
    tag: "spec-early",
    task: "Work step by step. (a) Read specs.txt carefully - it defines a format you must follow for a file you create later - then delete specs.txt. (b) Read all eight files under docs/. (c) Create out_data.txt: per the format specs.txt defined, with the value n = the number of non-empty lines in src/x.txt.",
    setupFiles: { "specs.txt": spec1, "src/x.txt": xItems, ...docsSetup },
    expectFile: "out_data.txt",
    expectLinesExact: ["DATA:07"],
  },
  {
    id: "spec-early-2",
    tag: "spec-early",
    task: "Work step by step. (a) Read specs.txt carefully - it defines how to write a summary file later - then delete specs.txt. (b) Read all eight files under docs/. (c) Following specs.txt exactly, create summary.txt from the numbers in src/y.txt.",
    setupFiles: { "specs.txt": spec2, "src/y.txt": yNums.join("\n") + "\n", ...docsSetup },
    expectFile: "summary.txt",
    expectLinesExact: [`R: ${[...yNums].sort((a, b) => b - a).join(" | ")}`],
  },
  {
    id: "balloon-stress",
    tag: "long-fidelity",
    task: "Work step by step. (a) Read all eight files under docs/ (d01.txt through d08.txt) and create counts.txt with one line per file in filename order: `<filename>: <number of whitespace-separated words in that file>`. (b) Then read src/a.txt and src/b.txt and append two more lines in the same format: `src/a.txt: <count>` and `src/b.txt: <count>`.",
    setupFiles: { ...docsSetup, "src/a.txt": aNums.join("\n") + "\n", "src/b.txt": bNums.join("\n") + "\n" },
    expectFile: "counts.txt",
    expectLinesExact: [
      ...Object.keys(docs).sort().map((n) => `${n}: ${wordCounts[n]}`),
      `src/a.txt: ${aNums.length}`,
      `src/b.txt: ${bNums.length}`,
    ],
  },
];

const set = {
  name: "coding-compact-v1",
  description:
    "Context-compaction fidelity: long multi-phase tasks whose correct end state depends on information that leaves the re-derivable workspace (overwritten seed, deleted config/specs, model-computed total) or spans eight balloon-reading phases. Run with a small preferenceTokens (compaction arm) vs a lifted budget (control arm). Generated by .claude/hillclimb/coding-tasks-compact/_tools/generate-set.mjs.",
  tasks,
};
fs.writeFileSync("evals/coding-compact-v1.json", JSON.stringify(set, null, 2) + "\n");
console.log("wrote evals/coding-compact-v1.json,", tasks.length, "tasks");
for (const t of tasks) console.log(`  ${t.id.padEnd(15)} ${t.tag.padEnd(16)} expected ${t.expectLinesExact.length} line(s)`);
console.log("word counts:", JSON.stringify(wordCounts));
