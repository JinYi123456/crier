import { sha256Hex } from './canonical';

/**
 * A seeded random source.
 *
 * The market has to be able to replay: the same seed, the same script, the same tape, on any
 * machine and in any test. So there is no Math.random anywhere in the engine - a
 * splitmix64 stream keyed off the session seed is the only source of noise, and it is
 * advanced explicitly so the order of draws is part of the record.
 */

const MASK64 = (1n << 64n) - 1n;

function splitmix64(state: bigint): { value: bigint; state: bigint } {
  let z = (state + 0x9e3779b97f4a7c15n) & MASK64;
  const next = z;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return { value: (z ^ (z >> 31n)) & MASK64, state: next };
}

export class Rng {
  private state: bigint;
  private readonly label: string;
  private draws = 0;

  constructor(label: string, ...parts: (string | number)[]) {
    this.label = [label, ...parts.map(String)].join('/');
    const digest = sha256Hex(this.label);
    this.state = BigInt('0x' + digest.slice(0, 16));
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.draws += 1;
    const { value, state } = splitmix64(this.state);
    this.state = state;
    return Number(value >> 11n) / 2 ** 53;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`int() needs a positive integer, got ${maxExclusive}`);
    return Math.floor(this.next() * maxExclusive);
  }

  range(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) throw new Error(`empty range ${minInclusive}..${maxInclusive}`);
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  /** Signed jitter expressed in basis points of `base`, rounded to a whole minor unit. */
  jitterBps(base: number, spreadBps: number): number {
    const span = Math.round((base * spreadBps) / 10_000);
    if (span <= 0) return base;
    return base + this.range(-span, span);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[this.int(items.length)] as T;
  }

  weighted<T>(entries: readonly { item: T; weight: number }[]): T {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) throw new Error('weights must sum to a positive number');
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry.item;
    }
    return entries[entries.length - 1]?.item as T;
  }

  /** Sample without replacement, in draw order. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const swap = out[i] as T;
      out[i] = out[j] as T;
      out[j] = swap;
    }
    return out;
  }

  get cursor(): { label: string; draws: number } {
    return { label: this.label, draws: this.draws };
  }
}

/** A stable 16-hex run id: same seed and same parameters, same id. */
export function runId(seed: string, ...parts: (string | number)[]): string {
  return sha256Hex(['crier/run', seed, ...parts.map(String)].join('|')).slice(0, 16);
}
