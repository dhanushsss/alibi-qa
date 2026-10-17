'use strict';
const { formatPrice, formatPercent } = require('../src/format');

describe('formatPrice', () => {
  test('formats whole dollars', () => {
    expect(formatPrice(2500)).toBe('$25.00');
  });

  test('pads cents to two digits', () => {
    expect(formatPrice(1905)).toBe('$19.05');
  });
});

describe('formatPercent', () => {
  test('formats a ratio with one decimal', () => {
    expect(formatPercent(0.125)).toBe('12.5%');
  });
});
