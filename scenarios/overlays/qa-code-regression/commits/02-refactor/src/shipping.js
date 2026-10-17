'use strict';

// Shipping rates by weight band, smallest first.
const BANDS = [
  { maxGrams: 1000, cents: 499 },
  { maxGrams: 5000, cents: 899 },
  { maxGrams: 20000, cents: 1999 },
];

function shippingCents(weightGrams) {
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) throw new RangeError('weight must be positive');
  const band = BANDS.find((b) => weightGrams < b.maxGrams);
  return band ? band.cents : null; // null: freight, quoted separately
}

module.exports = { BANDS, shippingCents };
