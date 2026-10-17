'use strict';
const { newOrderId } = require('../src/ids');

describe('newOrderId', () => {
  test('is prefixed and has 32 hex characters', () => {
    expect(newOrderId()).toMatch(/^ord_[0-9a-f]{32}$/);
  });

  test('does not repeat across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newOrderId()));
    expect(ids.size).toBe(50);
  });
});
