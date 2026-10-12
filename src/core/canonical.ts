import { createHash } from 'node:crypto';

/**
 * Canonical serialisation of a protocol payload.
 *
 * A signature has to cover the same bytes on every machine, so the wire format sorts
 * object keys, refuses anything that is not JSON, and refuses floats - a value that
 * cannot be represented exactly as an integer is a bug we want to hear about, not a
 * rounding difference we would have to chase later.
 */

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

function isPlainObject(value: object): value is Record<string, CanonicalValue> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validate(value: unknown, path: string): CanonicalValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value as boolean | string;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new CanonicalError(`${path}: non-finite number`);
    if (!Number.isSafeInteger(value as number)) {
      throw new CanonicalError(`${path}: ${value} is not a safe integer - protocol numbers are integers or strings`);
    }
    return value as number;
  }
  if (type === 'bigint') throw new CanonicalError(`${path}: bigint is not representable, use a decimal string`);
  if (type !== 'object') throw new CanonicalError(`${path}: unsupported type ${type}`);
  if (Array.isArray(value)) return value.map((item, index) => validate(item, `${path}[${index}]`));
  if (!isPlainObject(value as object)) throw new CanonicalError(`${path}: only plain objects may be signed`);
  const out: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    out[key] = validate(item, `${path}.${key}`);
  }
  return out;
}

function stringify(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(value[k] as CanonicalValue)}`).join(',')}}`;
}

export function canonicalize(value: unknown): CanonicalValue {
  return validate(value, '$');
}

export function canonicalJson(value: unknown): string {
  return stringify(canonicalize(value));
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Deterministic identity. Given the same seed and the same sequence number the same id
 * comes out, which is what makes a recorded session byte-comparable across machines.
 */
export function derivedId(prefix: string, ...parts: (string | number)[]): string {
  const digest = sha256Hex(parts.map((p) => String(p)).join('|'));
  return `${prefix}_${digest.slice(0, 20)}`;
}

/** 32 hex chars grouped for human reading ("a1b2 c3d4 ..."). */
export function fingerprint(hex: string, groups = 8): string {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  const size = Math.max(2, Math.floor(clean.length / groups));
  const out: string[] = [];
  for (let i = 0; i < clean.length && out.length < groups; i += size) out.push(clean.slice(i, i + size));
  return out.join(' ');
}
