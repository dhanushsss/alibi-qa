'use strict';
const { mulberry32, plan } = require('../src/batcher');

describe('plan', () => {
  test('schedules every notification exactly once', () => {
    const ids = plan(['a', 'b', 'c', 'd'], { random: mulberry32(1) }).map((n) => n.id);
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('delivers notifications in submission order', () => {
    const random = mulberry32(jest.getSeed());
    const order = plan(['a', 'b', 'c'], { random }).map((n) => n.id);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
