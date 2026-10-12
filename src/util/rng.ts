// Seeded PRNG (mulberry32) so the same seed always yields the same bank.

export interface Rng {
  next(): number;
  bool(pTrue?: number): boolean;
  int(min: number, max: number, step?: number): number;
  money(min: number, max: number, step: number): number;
  rate(min: number, max: number, step: number): number;
  pick<T>(items: readonly T[]): T;
  subset<T>(items: readonly T[], min: number, max: number): T[];
}

// Scramble the seed (murmur3 finalizer) so consecutive seeds give unrelated streams.
function mixSeed(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// `stream` gives independent sequences for one seed (config, database, documents),
// so changing how one is sampled never shifts the others. Stream 0 is the config.
export function createRng(seed: number, stream = 0): Rng {
  let a = mixSeed((seed + Math.imul(stream, 0x9e3779b9)) >>> 0);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number, step = 1): number => {
    const slots = Math.floor((max - min) / step) + 1;
    return min + Math.floor(next() * slots) * step;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[Math.floor(next() * items.length)] as T;
  };

  return {
    next,
    bool: (pTrue = 0.5) => next() < pTrue,
    int,
    // Dollar amounts on a step grid, e.g. money(500, 2500, 250).
    money: (min, max, step) => int(min, max, step),
    // Percentages on a step grid, rounded to avoid float noise (0.1 + 0.2).
    rate: (min, max, step) => {
      const slots = Math.round((max - min) / step) + 1;
      const value = min + Math.floor(next() * slots) * step;
      return Math.round(value * 1000) / 1000;
    },
    pick,
    subset: (items, min, max) => {
      const count = int(min, Math.min(max, items.length));
      const pool = [...items];
      const chosen: (typeof items)[number][] = [];
      while (chosen.length < count) {
        const i = Math.floor(next() * pool.length);
        chosen.push(pool.splice(i, 1)[0] as (typeof items)[number]);
      }
      return chosen;
    },
  };
}
