// Seeded PRNG for the shared piece sequence in online play: the same seed
// gives both devices the same pieces in the same order.

/** mulberry32: a small, fast 32-bit generator. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A new random 32-bit seed. */
export function randomSeed(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}
