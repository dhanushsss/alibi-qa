import { newOrderId } from './ids';

test('order ids are prefixed and URL-safe', () => {
  expect(newOrderId()).toMatch(/^ord_[A-Za-z0-9_-]{12}$/);
});
