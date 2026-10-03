const config = require("./config");

function restockList(items) {
  // Items at or below the restock threshold need ordering.
  const threshold = config.threshold ?? 2;
  return items.filter((item) => item.stock <= threshold).map((item) => item.sku);
}

module.exports = { restockList };
