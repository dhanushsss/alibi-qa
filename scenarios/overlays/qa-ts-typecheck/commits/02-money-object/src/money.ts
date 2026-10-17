export interface Money {
  cents: number;
  text: string;
}

/** Formats cents as money, e.g. 1234 -> { cents: 1234, text: "$12.34" }. */
export function formatCents(cents: number): Money {
  return { cents, text: `$${(cents / 100).toFixed(2)}` };
}
