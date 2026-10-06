const { total } = require("./pricing.js");
const { applyDiscount } = require("./discount.js");

// Final payable amount for a cart.
function checkout(items, discountPercent = 0) {
  return applyDiscount(total(items), discountPercent);
}

module.exports = { checkout };
