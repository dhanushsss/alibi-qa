import { nanoid } from 'nanoid';

/** Order ids look like "ord_" followed by 12 URL-safe characters. */
export function newOrderId(): string {
  return `ord_${nanoid(12)}`;
}
