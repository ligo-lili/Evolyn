const assert = require("assert");
const { formatUser, parseUser } = require("./index.js");

const user = { first: "Grace", last: "Hopper" };
const text = formatUser(user);
assert.strictEqual(text, "Hopper, Grace");
const back = parseUser(text);
assert.deepStrictEqual(back, user, "round-trip must preserve the user");
console.log("all tests passed");
