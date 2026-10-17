/** Discount tiers, highest first. A tier applies from its threshold, inclusive. */
const TIERS = [
  { minCents: 25000, rate: 0.15 },
  { minCents: 10000, rate: 0.1 },
];

export function discountRate(subtotalCents: number): number {
  for (const t of TIERS) {
    if (subtotalCents >= t.minCents) return t.rate;
  }
  return 0;
}
