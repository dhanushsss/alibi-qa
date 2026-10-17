import { renderReceipt } from './receipt';

test('renders lines and the total', () => {
  expect(renderReceipt([{ item: 'tea', cents: 350 }, { item: 'cake', cents: 425 }])).toBe('tea: $3.50\ncake: $4.25\nTotal: $7.75');
});
