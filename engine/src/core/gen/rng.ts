/**
 * The generator's random numbers (plans/random_holes.md): sfc32, seeded
 * from one 32-bit number, so a seed names a course. Nothing in the
 * generator may use Math.random; core stays deterministic.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.next(); // stir
  }

  /** A uniform 32-bit unsigned integer. */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  float(): number {
    return this.next() / 0x1_0000_0000;
  }

  /** An integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('pick from an empty list');
    return xs[Math.floor(this.float() * xs.length)];
  }

  /** One of `xs`, by the weights `ws` (same length, non-negative, not all 0). */
  weighted<T>(xs: readonly T[], ws: readonly number[]): T {
    const total = ws.reduce((s, w) => s + w, 0);
    let r = this.float() * total;
    for (let i = 0; i < xs.length; i++) {
      r -= ws[i];
      if (r < 0) return xs[i];
    }
    return xs[xs.length - 1];
  }

  /** Fisher-Yates, in place; returns the array. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }
}

/** A derived seed: hole k of a course, attempt n of a hole (a 32-bit mix). */
export function mixSeed(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
