'use strict';

/** Small deterministic PRNG so a run can be replayed from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plans delivery times for a batch: submission order spaced by `spacingMs`,
 * plus random jitter to spread load. Jitter larger than the spacing can
 * reorder neighbours — the latent bug this fixture exercises.
 */
function plan(ids, { spacingMs = 100, jitterMs = 250, random = Math.random } = {}) {
  return ids
    .map((id, i) => ({ id, at: i * spacingMs + Math.floor(random() * jitterMs) }))
    .sort((a, b) => a.at - b.at);
}

module.exports = { mulberry32, plan };
