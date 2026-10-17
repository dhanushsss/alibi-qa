'use strict';

// Shipping rates by weight band. A parcel belongs to the first band whose
// limit it does not exceed.
const BANDS = [
  { maxGrams: 1000, cents: 499 },
  { maxGrams: 5000, cents: 899 },
  { maxGrams: 20000, cents: 1999 },
];

function shippingCents(weightGrams) {
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) throw new RangeError('weight must be positive');
  for (const band of BANDS) {
    if (weightGrams <= band.maxGrams) return band.cents;
  }
  return null; // freight: quoted separately
}

module.exports = { BANDS, shippingCents };
