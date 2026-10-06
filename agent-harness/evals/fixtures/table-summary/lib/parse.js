// Parse "name,qty" rows out of a CSV-ish text block.
function parseRows(text) {
  return text.split("\n").map((line) => {
    const [name, qty] = line.split(",");
    return { name, qty: Number(qty) };
  });
}

module.exports = { parseRows };
