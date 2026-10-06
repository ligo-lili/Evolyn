// Summarizes a ledger at the point in time the report is created.
function createReport(ledger) {
  const frozen = ledger.all();
  return {
    total() {
      return frozen.reduce((sum, e) => sum + e.amount, 0);
    },
    count() {
      return frozen.length;
    },
  };
}

module.exports = { createReport };
