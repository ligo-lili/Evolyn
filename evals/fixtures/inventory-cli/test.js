const assert = require("assert");
const { restockList } = require("./service.js");

const items = [
  { sku: "A", stock: 3 },
  { sku: "B", stock: 7 },
  { sku: "C", stock: 5 },
];
assert.deepStrictEqual(restockList(items), ["A", "C"], "threshold is 5 from config");
console.log("all tests passed");
