const { scaleReading } = require("./scale.js");

// Render a series of readings as "raw->scaled" pairs.
function renderSeries(readings, min, max) {
  return readings.map((r) => r + "->" + scaleReading(r, min, max)).join(" ");
}

module.exports = { renderSeries };
