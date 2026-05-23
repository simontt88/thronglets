// FNV-1a 32-bit hash. Pure function, deterministic, no deps.
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// xorshift32 PRNG seeded from any 32-bit number.
// Returns a generator function producing uint32 values.
export function rng(seed: number): () => number {
  let s = seed | 0;
  if (s === 0) s = 0x6d2b79f5;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

// Pick an index in [0, n) from a 32-bit value. Modulo bias is irrelevant for our use.
export function pickIdx(value: number, n: number): number {
  return (value >>> 0) % n;
}
