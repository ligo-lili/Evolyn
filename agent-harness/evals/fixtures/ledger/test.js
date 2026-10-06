const assert = require("assert");
const { createLedger } = require("./lib/ledger.js");
const { createReport } = require("./lib/report.js");

const ledger = createLedger();
ledger.add({ amount: 10 });
ledger.add({ amount: 32 });

const before = ledger.all();
assert.strictEqual(before.length, 2, "all() reflects the current entries");

const report = createReport(ledger);
ledger.add({ amount: 7 });
assert.strictEqual(before.length, 2, "an earlier all() result must not change");
assert.strictEqual(ledger.size(), 3, "size() tracks new entries");
assert.strictEqual(report.total(), 42, "the report is a snapshot of its creation time");
assert.strictEqual(report.count(), 2, "the report count is a snapshot too");
console.log("all tests passed");
