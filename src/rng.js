// ============================================================
// rng.js — Seedable PRNG for deterministic game state
// Uses mulberry32. Same seed + same action sequence = same game.
// ============================================================

/**
 * Create a new RNG state from a seed.
 * Returns { seed, count } — embed in game state.
 */
export function makeRng(seed) {
  return { seed: seed >>> 0, count: 0 };
}

/**
 * Advance the RNG and return { value, rng }.
 * value is a float in [0, 1).
 * rng is the new RNG state (count incremented).
 * PURE — does not mutate the input.
 */
export function nextFloat(rng) {
  let t = (rng.seed + 0x6D2B79F5 + rng.count * 0x9E3779B9) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: { seed: rng.seed, count: rng.count + 1 } };
}

/**
 * Return a random integer in [0, n) and the advanced RNG.
 * PURE.
 */
export function nextInt(rng, n) {
  const r = nextFloat(rng);
  return { value: Math.floor(r.value * n), rng: r.rng };
}

/**
 * Shuffle an array (Fisher-Yates) using the seeded RNG.
 * Returns { value: shuffledCopy, rng: advancedRng }.
 * PURE — does not mutate the input array.
 */
export function shuffleWithRng(arr, rng) {
  const a = arr.slice();
  let r = rng;
  for (let i = a.length - 1; i > 0; i--) {
    const result = nextInt(r, i + 1);
    r = result.rng;
    [a[i], a[result.value]] = [a[result.value], a[i]];
  }
  return { value: a, rng: r };
}

/**
 * Roll 2d6 (or 3d6 keep best 2 for tactician).
 * Returns { sum, dice, rng }.
 * PURE.
 */
export function roll2d6(rng, tactician = false) {
  const count = tactician ? 3 : 2;
  const dice = [];
  let r = rng;
  for (let i = 0; i < count; i++) {
    const result = nextInt(r, 6);
    r = result.rng;
    dice.push(result.value + 1);
  }
  if (tactician) {
    dice.sort((a, b) => b - a);
    const kept = [dice[0], dice[1]];
    return { sum: kept[0] + kept[1], dice: kept, allDice: dice, rng: r };
  }
  return { sum: dice[0] + dice[1], dice, rng: r };
}
