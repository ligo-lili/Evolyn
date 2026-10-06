// Append-only entry store.
function createLedger() {
  const entries = [];
  return {
    add(entry) {
      entries.push(entry);
    },
    all() {
      return entries;
    },
    size() {
      return entries.length;
    },
  };
}

module.exports = { createLedger };
