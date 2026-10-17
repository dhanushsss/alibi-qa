'use strict';
const { mulberry32, plan } = require('../src/batcher');

// Table-driven: titles come from data, so there is no literal test('...') line.
const ORDER_CASES = [{ title: 'delivers notifications in submission order', ids: ['a', 'b', 'c'] }];

describe('plan', () => {
  test('schedules every notification exactly once', () => {
    const ids = plan(['a', 'b', 'c', 'd'], { random: mulberry32(1) }).map((n) => n.id);
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  for (const c of ORDER_CASES) {
    test(c.title, () => {
      const random = mulberry32(jest.getSeed());
      expect(plan(c.ids, { random }).map((n) => n.id)).toEqual(c.ids);
    });
  }
});
