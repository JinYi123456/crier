import { describe, expect, it } from 'vitest';
import {
  allocate,
  decimals,
  formatMoney,
  fromDecimalString,
  money,
  renderMoney,
  sub,
  toDecimalString,
  MoneyError,
} from '../src/core/money';

describe('money', () => {
  it('keeps minor units integral for 0-, 2- and 3-decimal currencies', () => {
    expect(decimals('JPY')).toBe(0);
    expect(decimals('USD')).toBe(2);
    expect(decimals('KWD')).toBe(3);
    expect(fromDecimalString('JPY', '1200').minor).toBe(1200);
    expect(fromDecimalString('USD', '1200').minor).toBe(120_000);
    expect(fromDecimalString('KWD', '1.234').minor).toBe(1234);
  });

  it('refuses a value that cannot be an exact number of minor units', () => {
    expect(() => money('USD', 12.5)).toThrow(MoneyError);
    expect(() => fromDecimalString('KWD', '1.23456')).toThrow(/too many decimals/);
  });

  it('rounds a half cent up exactly once, and only at the documented edge', () => {
    expect(toDecimalString(fromDecimalString('USD', '0.005'))).toBe('0.01');
    expect(toDecimalString(fromDecimalString('USD', '0.004'))).toBe('0.00');
    expect(toDecimalString(fromDecimalString('USD', '-0.005'))).toBe('-0.01');
  });

  it('formats and re-parses without drift', () => {
    for (const raw of ['0.01', '1234.56', '99999.99', '-45.30']) {
      const value = fromDecimalString('USD', raw);
      expect(toDecimalString(value)).toBe(raw);
      expect(toDecimalString(fromDecimalString('USD', toDecimalString(value)))).toBe(raw);
    }
    expect(formatMoney(money('USD', 123_456))).toBe('$1,234.56');
    expect(renderMoney(money('EUR', 500))).toBe('5.00 EUR');
    expect(renderMoney(money('JPY', 500))).toBe('500 JPY');
  });

  it('subtracts only within one currency', () => {
    expect(() => sub(money('USD', 100), money('EUR', 40))).toThrow(/currency mismatch/);
  });

  it('allocates without inventing or losing a unit', () => {
    const parts = allocate(100, [1, 1, 1], 'USD');
    const total = parts.reduce((sum, p) => sum + p.minor, 0);
    expect(total).toBe(100);
    expect(parts.map((p) => p.minor)).toEqual([34, 33, 33]);

    expect(allocate(7, [3, 4], 'USD').reduce((s, p) => s + p.minor, 0)).toBe(7);
    expect(allocate(0, [5, 5], 'USD').map((p) => p.minor)).toEqual([0, 0]);
    expect(() => allocate(10, [0, 0], 'USD')).toThrow(/positive/);
  });
});
