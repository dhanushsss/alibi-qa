import { discountRate } from './discounts';

describe('discountRate', () => {
  test('no discount below $100', () => expect(discountRate(9999)).toBe(0));
  test('applies 10% at exactly $100.00', () => expect(discountRate(10000)).toBe(0.1));
  test('applies 15% from $250', () => expect(discountRate(25000)).toBe(0.15));
  test('keeps 15% above $250', () => expect(discountRate(40000)).toBe(0.15));
});
