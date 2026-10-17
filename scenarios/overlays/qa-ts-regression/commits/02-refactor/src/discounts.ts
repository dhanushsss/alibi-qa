/** Discount tiers, highest first. A tier applies from its threshold, inclusive. */
const TIERS = [
  { minCents: 25000, rate: 0.15 },
  { minCents: 10000, rate: 0.1 },
] as const;

export function discountRate(subtotalCents: number): number {
  const tier = TIERS.find((t) => subtotalCents > t.minCents);
  return tier ? tier.rate : 0;
}
