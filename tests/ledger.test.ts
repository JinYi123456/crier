import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/core/ledger';
import { MoneyError } from '../src/core/money';
import {
  ACCOUNT,
  DEFAULT_FEE_SCHEDULE,
  feeFor,
  buyerAccounts,
  openBooks,
  recordCapture,
  recordDeposit,
  recordFeeSweep,
  recordPayout,
  recordRefund,
  recordVoid,
} from '../src/core/books';

const T0 = 1_700_000_000_000;

function opened(floatMinor = 5_000_000): Ledger {
  const ledger = new Ledger();
  openBooks(ledger, { currency: 'USD', feeSchedule: DEFAULT_FEE_SCHEDULE, openingFloatMinor: floatMinor }, T0);
  return ledger;
}

describe('ledger invariants', () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = opened();
  });

  it('refuses an entry whose debits do not equal its credits', () => {
    expect(() =>
      ledger.post({
        ts: T0,
        memo: 'lopsided',
        code: 'SETTLEMENT',
        currency: 'USD',
        idempotencyKey: 'k1',
        postings: [
          { account: ACCOUNT.escrow, debit: 1000, credit: 0 },
          { account: ACCOUNT.settlementBank, debit: 0, credit: 999 },
        ],
      }),
    ).toThrow(MoneyError);
    expect(ledger.size).toBe(1); // only the opening balance survived
  });

  it('refuses a single-line entry, a zero line, and a line with both sides', () => {
    const base = { ts: T0, memo: 'm', code: 'SETTLEMENT', currency: 'USD' } as const;
    expect(() =>
      ledger.post({ ...base, idempotencyKey: 'one-line', postings: [{ account: ACCOUNT.escrow, debit: 5, credit: 0 }] }),
    ).toThrow(/at least two postings/);
    expect(() =>
      ledger.post({
        ...base,
        idempotencyKey: 'zero',
        postings: [
          { account: ACCOUNT.escrow, debit: 0, credit: 0 },
          { account: ACCOUNT.settlementBank, debit: 3, credit: 3 },
        ],
      }),
    ).toThrow(/moves nothing|both a debit/);
    expect(() =>
      ledger.post({
        ...base,
        idempotencyKey: 'both',
        postings: [
          { account: ACCOUNT.escrow, debit: 10, credit: 10 },
          { account: ACCOUNT.settlementBank, debit: 0, credit: 5 },
        ],
      }),
    ).toThrow(/both a debit and a credit/);
  });

  it('refuses accounts that are not in the chart', () => {
    expect(() =>
      ledger.post({
        ts: T0,
        memo: 'ghost',
        code: 'SETTLEMENT',
        currency: 'USD',
        idempotencyKey: 'ghost',
        postings: [
          { account: 'asset:under_the_mattress', debit: 100, credit: 0 },
          { account: ACCOUNT.settlementBank, debit: 0, credit: 100 },
        ],
      }),
    ).toThrow(/unknown account/);
  });

  it('refuses to mix currencies inside one entry', () => {
    const euro = new Ledger();
    euro.declare({ id: 'a', name: 'a', type: 'asset', currency: 'EUR' });
    euro.declare({ id: 'b', name: 'b', type: 'asset', currency: 'USD' });
    expect(() =>
      euro.post({
        ts: T0,
        memo: 'mix',
        code: 'SETTLEMENT',
        currency: 'USD',
        idempotencyKey: 'mix',
        postings: [
          { account: 'a', debit: 10, credit: 0 },
          { account: 'b', debit: 0, credit: 10 },
        ],
      }),
    ).toThrow(/is EUR but the entry is USD/);
  });

  it('treats a repeated idempotency key as the same entry, not a second movement of money', () => {
    buyerAccounts(ledger, 'buyer-a', 'USD');
    const first = ledger.post({
      ts: T0,
      memo: 'hold',
      code: 'ESCROW_HOLD',
      currency: 'USD',
      idempotencyKey: 'deposit:order-1',
      postings: [
        { account: ACCOUNT.escrow, debit: 5000, credit: 0 },
        { account: ACCOUNT.dueToBuyer('buyer-a'), debit: 0, credit: 5000 },
      ],
    });
    const retry = ledger.post({
      ts: T0 + 1,
      memo: 'hold',
      code: 'ESCROW_HOLD',
      currency: 'USD',
      idempotencyKey: 'deposit:order-1',
      postings: [
        { account: ACCOUNT.escrow, debit: 5000, credit: 0 },
        { account: ACCOUNT.dueToBuyer('buyer-a'), debit: 0, credit: 5000 },
      ],
    });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.entry.id).toBe(first.entry.id);
    expect(ledger.balanceOf(ACCOUNT.escrow)).toBe(5000);
  });

  it('rejects a reused idempotency key carrying a different shape', () => {
    buyerAccounts(ledger, 'buyer-a', 'USD');
    ledger.post({
      ts: T0,
      memo: 'hold',
      code: 'ESCROW_HOLD',
      currency: 'USD',
      idempotencyKey: 'dup',
      postings: [
        { account: ACCOUNT.escrow, debit: 100, credit: 0 },
        { account: ACCOUNT.dueToBuyer('buyer-a'), debit: 0, credit: 100 },
      ],
    });
    expect(() =>
      ledger.post({
        ts: T0,
        memo: 'hold, but greedier',
        code: 'ESCROW_HOLD',
        currency: 'USD',
        idempotencyKey: 'dup',
        postings: [
          { account: ACCOUNT.escrow, debit: 200, credit: 0 },
          { account: ACCOUNT.dueToBuyer('buyer-a'), debit: 0, credit: 200 },
        ],
      }),
    ).toThrow(/already used for a different entry/);
  });

  it('will not let customer money fall below its floor', () => {
    expect(() =>
      ledger.post({
        ts: T0,
        memo: 'overdraft',
        code: 'SELLER_PAYOUT',
        currency: 'USD',
        idempotencyKey: 'over',
        postings: [
          { account: ACCOUNT.escrow, debit: 0, credit: 1 },
          { account: ACCOUNT.settlementBank, debit: 1, credit: 0 },
        ],
      }),
    ).toThrow(/below its floor/);
  });

  it('stays balanced through a full settlement and recomputes the same balances from the entries', () => {
    const gross = 250_000;
    recordDeposit(ledger, { ts: T0, buyer: 'buyer-kestrel', grossMinor: gross, orderId: 'order-9', currency: 'USD' });
    const capture = recordCapture(ledger, {
      ts: T0 + 1,
      buyer: 'buyer-kestrel',
      seller: 'seller-onyx',
      grossMinor: gross,
      tradeId: 'trade-9',
      orderId: 'order-9',
      currency: 'USD',
    });
    expect(capture.feeMinor).toBe(feeFor(gross, DEFAULT_FEE_SCHEDULE));
    expect(capture.netMinor + capture.feeMinor).toBe(gross);

    recordPayout(ledger, { ts: T0 + 2, seller: 'seller-onyx', netMinor: capture.netMinor, tradeId: 'trade-9', payoutId: 'payout-9', currency: 'USD' });
    recordFeeSweep(ledger, { ts: T0 + 3, feeMinor: capture.feeMinor, tradeId: 'trade-9', currency: 'USD' });

    expect(ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.dueToBuyer('buyer-kestrel'))).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.dueToSeller('seller-onyx'))).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(capture.feeMinor);
    expect(ledger.balanceOf(ACCOUNT.settlementBank)).toBe(5_000_000 + capture.feeMinor);
    expect(ledger.isBalanced()).toBe(true);
    expect(ledger.audit()).toEqual([]);

    const rebuilt = Ledger.fromJSON(ledger.toJSON());
    expect(rebuilt.totalDebit()).toBe(ledger.totalDebit());
    expect(rebuilt.balanceOf(ACCOUNT.settlementBank)).toBe(ledger.balanceOf(ACCOUNT.settlementBank));
    rebuilt.recompute();
    expect(rebuilt.balanceOf(ACCOUNT.escrow)).toBe(0);
  });

  it('books a post-payout refund as a fee reversal plus an explicit absorbed loss', () => {
    const gross = 250_000;
    recordDeposit(ledger, { ts: T0, buyer: 'buyer-kestrel', grossMinor: gross, orderId: 'order-10', currency: 'USD' });
    const capture = recordCapture(ledger, {
      ts: T0 + 1,
      buyer: 'buyer-kestrel',
      seller: 'seller-onyx',
      grossMinor: gross,
      tradeId: 'trade-10',
      orderId: 'order-10',
      currency: 'USD',
    });
    recordPayout(ledger, { ts: T0 + 2, seller: 'seller-onyx', netMinor: capture.netMinor, tradeId: 'trade-10', payoutId: 'payout-10', currency: 'USD' });
    recordFeeSweep(ledger, { ts: T0 + 3, feeMinor: capture.feeMinor, tradeId: 'trade-10', currency: 'USD' });

    const refund = recordRefund(ledger, {
      ts: T0 + 4,
      buyer: 'buyer-kestrel',
      seller: 'seller-onyx',
      refundMinor: gross,
      tradeId: 'trade-10',
      refundId: 'refund-10',
      currency: 'USD',
      feeReversalMinor: capture.feeMinor,
      source: 'settlement_bank',
    });

    expect(refund.absorbedMinor).toBe(capture.netMinor);
    expect(ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.chargebackLoss)).toBe(capture.netMinor);
    expect(ledger.balanceOf(ACCOUNT.dueToBuyer('buyer-kestrel'))).toBe(0);
    expect(ledger.isBalanced()).toBe(true);
    expect(ledger.audit()).toEqual([]);
  });

  it('refuses to fund a refund the settlement bank cannot cover', () => {
    const thin = opened(0);
    recordDeposit(thin, { ts: T0, buyer: 'b', grossMinor: 100_000, orderId: 'order-11', currency: 'USD' });
    const capture = recordCapture(thin, { ts: T0 + 1, buyer: 'b', seller: 's', grossMinor: 100_000, tradeId: 'trade-11', orderId: 'order-11', currency: 'USD' });
    expect(() =>
      recordRefund(thin, {
        ts: T0 + 2,
        buyer: 'b',
        seller: 's',
        refundMinor: 100_000,
        tradeId: 'trade-11',
        refundId: 'refund-11',
        currency: 'USD',
        feeReversalMinor: capture.feeMinor,
        source: 'settlement_bank',
      }),
    ).toThrow(/below its floor/);
  });

  it('releases an uncaptured authorisation back to the buyer from escrow', () => {
    const gross = 80_000;
    recordDeposit(ledger, { ts: T0, buyer: 'buyer-wren', grossMinor: gross, orderId: 'order-12', currency: 'USD' });
    recordVoid(ledger, { ts: T0 + 1, buyer: 'buyer-wren', grossMinor: gross, orderId: 'order-12', currency: 'USD' });
    expect(ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.dueToBuyer('buyer-wren'))).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(ledger.isBalanced()).toBe(true);
  });

  it('computes the published fee, capped at the gross', () => {
    expect(feeFor(250_000, DEFAULT_FEE_SCHEDULE)).toBe(7505);
    expect(feeFor(10, DEFAULT_FEE_SCHEDULE)).toBe(10);
    expect(feeFor(0, DEFAULT_FEE_SCHEDULE)).toBe(0);
  });
});
