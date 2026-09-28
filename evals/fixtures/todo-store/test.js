const assert = require("assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { save, load } = require("./store.js");

const file = path.join(os.tmpdir(), "todo-store-test-" + process.pid + ".json");
const todos = [{ id: 1, text: "write tests", done: true }];
save(file, todos);
assert.deepStrictEqual(load(file), todos, "round-trip must preserve the done flag");
fs.rmSync(file, { force: true });
console.log("all tests passed");
