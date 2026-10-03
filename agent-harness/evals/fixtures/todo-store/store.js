const fs = require("node:fs");

function save(file, todos) {
  const rows = todos.map((t) => ({ id: t.id, text: t.text, done: t.done ? 1 : 0 }));
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
}

// BUG: load() reimplements the wire format instead of using
// serializer.fromJSON — the two encodings drifted apart ("1" vs 1).
function load(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  return rows.map((row) => ({ id: row.id, text: row.text, done: row.done === "1" }));
}

module.exports = { save, load };
