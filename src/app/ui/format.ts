import { formatMoney, money, type CurrencyCode } from '../../core/money';

/** Money the way a pit reads it: tabular, and always the currency the room settles in. */
export function cash(minor: number, currency: CurrencyCode): string {
  return formatMoney(money(currency, Math.round(minor)));
}

export function shortKey(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function clockOf(at: number): string {
  const date = new Date(at);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
