'use strict';
const { formatCents } = require('../src/format');

test('formats cents as dollars', () => {
  expect(formatCents(1999)).toBe('$19.99');
});
