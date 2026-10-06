const assert = require("assert");
const { list } = require("./lib/api.js");

const items = ["i1", "i2", "i3", "i4", "i5", "i6", "i7"];
assert.deepStrictEqual(list(items, { page: 1, size: 3 }).items, ["i1", "i2", "i3"], "page 1");
assert.deepStrictEqual(list(items, { page: 3, size: 3 }).items, ["i7"], "page 3 keeps the tail");
assert.strictEqual(list(items, { page: 2, size: 3 }).hasMore, true, "page 2 has more");
assert.strictEqual(list(items, { page: 3, size: 3 }).hasMore, false, "page 3 is last");
assert.strictEqual(list(items, { page: 1, size: 4 }).items.length, 4, "size-4 page is full");
console.log("all tests passed");
