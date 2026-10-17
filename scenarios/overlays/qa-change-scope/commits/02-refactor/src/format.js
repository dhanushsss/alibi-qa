'use strict';

const DOLLAR = '$';

/** Formats an integer number of cents as dollars with two decimals. */
function formatCents(cents) {
  const dollars = cents / 100;
  return DOLLAR + dollars.toFixed(2);
}

module.exports = { formatCents };
