'use strict';
const { formatPrice } = require('../src/format');

describe('formatPrice', () => {
  test('formats whole dollars', () => {
    expect(formatPrice(2500)).toBe('$25.00');
  });

  test('pads cents to two digits', () => {
    expect(formatPrice(1905)).toBe('$19.05');
  });
});
