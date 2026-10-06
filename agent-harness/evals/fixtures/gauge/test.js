const assert = require("assert");
const { scaleReading } = require("./lib/scale.js");
const { renderSeries } = require("./lib/view.js");

assert.strictEqual(scaleReading(5, 0, 10), 5, "a reading inside the range stays");
assert.strictEqual(scaleReading(15, 0, 10), 10, "above the range clamps to max");
assert.strictEqual(scaleReading(-3, 0, 10), 0, "below the range clamps to min");
assert.strictEqual(renderSeries([5, 15, -3], 0, 10), "5->5 15->10 -3->0");
console.log("all tests passed");
