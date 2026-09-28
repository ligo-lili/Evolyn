// LEGACY v1 parser (swaps the fields). Kept only for one caller that still
// depends on the old behaviour — do not use in new code.
function parseUser(text) {
  const parts = text.split(", ");
  return { first: parts[0], last: parts[1] };
}

module.exports = { parseUser };
