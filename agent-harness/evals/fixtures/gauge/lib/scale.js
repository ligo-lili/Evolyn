const { clamp } = require("./bounds.js");

// Map one raw reading into the channel range [min, max].
function scaleReading(reading, min, max) {
  return clamp(max, reading, min);
}

module.exports = { scaleReading };
