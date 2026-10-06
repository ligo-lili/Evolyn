const { page } = require("./pager.js");

// Turns query params into a listing response.
function list(items, query = {}) {
  const pageNumber = Number(query.page ?? 1);
  const pageSize = Number(query.size ?? 3);
  return {
    items: page(items, pageNumber, pageSize),
    hasMore: pageNumber * pageSize < items.length,
  };
}

module.exports = { list };
