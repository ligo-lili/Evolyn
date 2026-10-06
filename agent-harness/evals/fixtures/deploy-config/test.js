const assert = require("assert");
const { buildPlan } = require("./lib/plan.js");
const { describe } = require("./lib/summary.js");

const items = ["a", "b", "c", "d", "e", "f", "g"];
const plan = buildPlan(items);
assert.strictEqual(plan.batches.length, 2, "7 items in batches of 4 make 2 batches");
assert.strictEqual(plan.batches[0].length, 4, "first batch is full");
assert.strictEqual(plan.batches[1].length, 3, "second batch holds the remainder");
assert.strictEqual(plan.retries, 2, "default retries come from defaults.js");
assert.strictEqual(describe(plan), "2 batches, up to 4 each, 2 retries");
console.log("all tests passed");
