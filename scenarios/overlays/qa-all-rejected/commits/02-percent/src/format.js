'use strict';

// Integer arithmetic only: avoids floating-point surprises in toFixed.
function formatPrice(cents) {
  const dollars = Math.floor(cents / 100);
  return `$${dollars}.${cents % 100 === 0 ? '00' : cents % 100}`;
}

function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

module.exports = { formatPrice, formatPercent };
