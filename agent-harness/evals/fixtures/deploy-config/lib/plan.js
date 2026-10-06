const defaults = require("./defaults");

// Builds a deployment plan: split items into batches of at most `maxBatch`.
function buildPlan(items, options = {}) {
  const maxBatch = options.maxBatch ?? defaults.limits.batchSize ?? 1;
  const retries = options.retries ?? defaults.retries;
  const batches = [];
  for (let i = 0; i < items.length; i += maxBatch) {
    batches.push(items.slice(i, i + maxBatch));
  }
  return { retries, batches };
}

module.exports = { buildPlan };
