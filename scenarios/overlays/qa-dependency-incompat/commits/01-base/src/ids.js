'use strict';

/** Order IDs: "ord_" followed by 32 lowercase hex characters. */
function newOrderId() {
  // Deep import kept from the original implementation.
  const v4 = require('uuid/v4');
  return `ord_${v4().replace(/-/g, '')}`;
}

module.exports = { newOrderId };
