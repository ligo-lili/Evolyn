const assert = require("assert");
const { total } = require("./lib/pricing.js");
const { applyDiscount } = require("./lib/discount.js");
const { checkout } = require("./lib/checkout.js");

const cart = [
  { price: 12, qty: 3 },
  { price: 5, qty: 4 },
  { price: 2, qty: 1 },
];
assert.strictEqual(total(cart), 58, "12*3 + 5*4 + 2*1");
assert.strictEqual(applyDiscount(50, 10), 45, "10% off 50");
assert.strictEqual(checkout(cart, 0), 58, "no discount");
assert.strictEqual(checkout(cart, 50), 29, "half off");
console.log("all tests passed");
