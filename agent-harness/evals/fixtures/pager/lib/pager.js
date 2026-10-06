// Slice one page out of a list. Pages are 1-based.
function page(items, pageNumber, pageSize) {
  const start = (pageNumber - 1) * pageSize;
  return items.slice(start, start + pageSize - 1);
}

module.exports = { page };
