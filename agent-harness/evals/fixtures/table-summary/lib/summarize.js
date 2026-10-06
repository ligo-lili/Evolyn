const { parseRows } = require("./parse.js");

// Count rows and total their quantities.
function summarize(text) {
  const rows = parseRows(text);
  return {
    count: rows.length,
    totalQty: rows.reduce((sum, r) => sum + r.qty, 0),
  };
}

module.exports = { summarize };
