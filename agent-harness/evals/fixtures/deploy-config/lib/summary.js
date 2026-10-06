// One-line human summary of a deployment plan.
function describe(plan) {
  const size = plan.batches[0] ? plan.batches[0].length : 0;
  return plan.batches.length + " batches, up to " + size + " each, " + plan.retries + " retries";
}

module.exports = { describe };
