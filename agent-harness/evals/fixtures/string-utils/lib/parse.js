// v2 parser: turns "Last, First" back into a user object.
function parseUser(text) {
  const parts = text.split(", ");
  return { last: parts[0], first: parts[1] };
}

module.exports = { parseUser };
