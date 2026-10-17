'use strict';
const { shippingCents } = require('../src/shipping');

describe('shippingCents', () => {
  test('charges the small-parcel rate up to and including 1 kg', () => {
    expect(shippingCents(1000)).toBe(499);
  });

  test('charges the medium rate just above 1 kg', () => {
    expect(shippingCents(1001)).toBe(899);
  });

  test('charges the large rate at exactly 20 kg', () => {
    expect(shippingCents(20000)).toBe(1999);
  });

  test('returns null for freight', () => {
    expect(shippingCents(20001)).toBeNull();
  });

  test('rejects non-positive weights', () => {
    expect(() => shippingCents(0)).toThrow(RangeError);
  });
});
