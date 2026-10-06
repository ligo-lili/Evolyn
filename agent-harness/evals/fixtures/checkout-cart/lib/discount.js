// Apply a percentage discount (0-100) to an amount.
function applyDiscount(amount, percent) {
  return amount - amount * percent;
}

module.exports = { applyDiscount };
