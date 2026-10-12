/**
 * Money in integer minor units.
 *
 * Every value that can move between two parties is stored as an integer count of the
 * currency's smallest unit. Floating point is only ever touched at the edges (parsing a
 * decimal string the way a human wrote it, formatting for a screen) and never used for
 * arithmetic that lands in the ledger.
 */

export const CURRENCIES = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  CAD: 2,
  AUD: 2,
  CNY: 2,
  INR: 2,
  SEK: 2,
  CHF: 2,
  MXN: 2,
  BRL: 2,
  KRW: 0,
  SGD: 2,
  HKD: 2,
  NZD: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  AED: 2,
  SAR: 2,
  ZAR: 2,
  TRY: 2,
  THB: 2,
  PHP: 2,
  IDR: 2,
  MYR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  IQD: 3,
  LYD: 3,
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

export interface Money {
  readonly currency: CurrencyCode;
  /** Integer count of the smallest unit of `currency`. Never fractional. */
  readonly minor: number;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function decimals(currency: CurrencyCode): number {
  const d = CURRENCIES[currency];
  if (d === undefined) throw new MoneyError(`unknown currency ${currency}`);
  return d;
}

export function assertMinor(minor: number, context = 'amount'): number {
  if (!Number.isInteger(minor)) throw new MoneyError(`${context} ${minor} is not an integer number of minor units`);
  if (Math.abs(minor) > MAX_SAFE_MINOR) throw new MoneyError(`${context} ${minor} exceeds the safe integer range`);
  return minor;
}

export function money(currency: CurrencyCode, minor: number): Money {
  assertMinor(minor, `${currency} amount`);
  return { currency, minor };
}

export function zero(currency: CurrencyCode): Money {
  return { currency, minor: 0 };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

export function neg(a: Money): Money {
  return money(a.currency, -a.minor);
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function cmp(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

/** One basis point is 1/100 of a percent, so 10_000 bps = 100%. */
export const BPS = 10_000;

export function mulBps(a: Money, bps: number, opts: { rounding?: 'half-up' | 'floor' | 'ceil' } = {}): Money {
  if (!Number.isInteger(bps)) throw new MoneyError(`bps must be an integer, got ${bps}`);
  const p = a.minor * bps;
  const r = opts.rounding === 'floor' ? Math.floor(p / BPS) : opts.rounding === 'ceil' ? Math.ceil(p / BPS) : halfUp(p, BPS);
  return money(a.currency, r);
}

function halfUp(numerator: number, denominator: number): number {
  if (numerator >= 0) return Math.floor((numerator + denominator / 2) / denominator);
  return -Math.floor((-numerator + denominator / 2) / denominator);
}

/**
 * Split `total` across `weights` without losing or inventing a unit: the proportional
 * parts are rounded down first, then the residual units are handed out to the largest
 * fractional remainders. Weights are integers (they are usually minor-unit amounts).
 */
export function allocate(total: number, weights: readonly number[], currency: CurrencyCode): Money[] {
  assertMinor(total, 'allocation total');
  const sum = weights.reduce((acc, w) => acc + assertMinor(w, 'allocation weight'), 0);
  if (sum <= 0) throw new MoneyError('allocation weights must sum to a positive number');
  if (weights.length === 0) return [];

  const base: number[] = [];
  const remainders: { index: number; frac: number }[] = [];
  let assigned = 0;
  weights.forEach((w, index) => {
    const exact = (total * w) / sum;
    const floor = Math.floor(exact);
    base[index] = floor;
    remainders.push({ index, frac: exact - floor });
    assigned += floor;
  });

  let residual = total - assigned;
  remainders.sort((a, b) => (b.frac === a.frac ? a.index - b.index : b.frac - a.frac));
  let cursor = 0;
  while (residual > 0) {
    const target = remainders[cursor % remainders.length];
    if (target) base[target.index] = (base[target.index] ?? 0) + 1;
    residual -= 1;
    cursor += 1;
  }
  return base.map((minor) => money(currency, minor));
}

/**
 * Parse the way a human writes an amount ("1,234.56", "1 234,56" is deliberately not
 * accepted - callers must hand us a canonical decimal string). Rejects anything that
 * would silently round, beyond the single documented half-up step.
 */
export function fromDecimalString(currency: CurrencyCode, raw: string): Money {
  const text = raw.trim().replace(/_/g, '');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError(`cannot parse amount "${raw}"`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  const fracPart = match[3] ?? '';
  const dp = decimals(currency);
  if (fracPart.length > dp + 1) throw new MoneyError(`amount "${raw}" has too many decimals for ${currency}`);
  const scaled = whole.padStart(1, '0') + fracPart.padEnd(dp + 1, '0');
  const truncated = BigInt(scaled.slice(0, whole.length + dp));
  const roundingDigit = Number(scaled.charAt(whole.length + dp));
  let minor = Number(truncated);
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount "${raw}" exceeds the safe integer range for ${currency}`);
  if (roundingDigit >= 5) minor += 1;
  return money(currency, sign * minor);
}

export function toDecimalString(value: Money): string {
  const dp = decimals(value.currency);
  const negative = value.minor < 0;
  const abs = Math.abs(value.minor).toString().padStart(dp + 1, '0');
  const whole = dp === 0 ? abs : abs.slice(0, abs.length - dp);
  const frac = dp === 0 ? '' : abs.slice(abs.length - dp);
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function minorPerUnit(currency: CurrencyCode): number {
  return 10 ** decimals(currency);
}

const formatters = new Map<CurrencyCode, Intl.NumberFormat>();

export function formatMoney(value: Money, locale = 'en-US'): string {
  let nf = formatters.get(value.currency);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: value.currency,
      minimumFractionDigits: decimals(value.currency),
      maximumFractionDigits: decimals(value.currency),
    });
    formatters.set(value.currency, nf);
  }
  return nf.format(value.minor / minorPerUnit(value.currency));
}

/** A stable, locale-free rendering used in logs, exports and tests. */
export function renderMoney(value: Money): string {
  return `${toDecimalString(value)} ${value.currency}`;
}
