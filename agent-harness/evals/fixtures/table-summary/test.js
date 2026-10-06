const assert = require("assert");
const { summarize } = require("./lib/summarize.js");

const data = [
  "name,qty",
  "bolts,3",
  "",
  "nuts,4",
  "washers,5",
  "screws,2",
  "",
].join("\n");

const summary = summarize(data);
assert.deepStrictEqual(summary, { count: 4, totalQty: 14 }, "four data rows with their quantities");
console.log("all tests passed");
