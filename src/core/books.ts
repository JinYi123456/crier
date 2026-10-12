import { Ledger, type Account, type EntryCode, type LedgerEntry, type Posting } from './ledger';
import { BPS, type CurrencyCode } from './money';

/**
 * The platform's books.
 *
 * Crier is a marketplace that holds other people's money, so the ledger is written the way a
 * payment facilitator writes it: buyer funds sit in an escrow asset with an exactly equal
 * liability to the buyer, the sale moves that liability to the seller net of the fee, and only
 * then does cash leave. Every dollar that arrives must be somebody's claim until it is spent,
 * which is why the escrow account can never quietly go negative.
 */

export const ACCOUNT = {
  escrow: 'asset:escrow',
  settlementBank: 'asset:settlement_bank',
  dueToBuyer: (party: string) => `liability:due_to_buyer:${party}`,
  dueToSeller: (party: string) => `liability:due_to_seller:${party}`,
  feeRevenue: 'revenue:transaction_fee',
  chargebackLoss: 'expense:chargeback_absorbed',
  openingEquity: 'equity:opening_balance',
} as const;

export interface FeeSchedule {
  /** Percentage component in basis points of the gross. */
  readonly bps: number;
  /** Flat component in minor units per settlement. */
  readonly fixedMinor: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = { bps: 299, fixedMinor: 30 };

/** Fee for a gross amount: percentage rounded up to the unit, plus a flat line, capped at gross. */
export function feeFor(grossMinor: number, schedule: FeeSchedule): number {
  const percentage = Math.ceil((grossMinor * schedule.bps) / BPS);
  return Math.max(0, Math.min(grossMinor, percentage + schedule.fixedMinor));
}

export function ensureAccount(ledger: Ledger, account: Account): Account {
  if (!ledger.hasAccount(account.id)) return ledger.declare(account);
  return ledger.account(account.id);
}

export interface BooksConfig {
  readonly currency: CurrencyCode;
  readonly feeSchedule: FeeSchedule;
  /** Seed cash the platform floats so the very first settlement has somewhere to come from. */
  readonly openingFloatMinor: number;
}

/**
 * Declare the accounts a session needs and put the opening float on the books. Double entry
 * means seeded cash has to come from somewhere, and "somewhere" is the platform's own equity.
 */
export function openBooks(ledger: Ledger, config: BooksConfig, now: number): void {
  const { currency } = config;
  const accounts: Account[] = [
    { id: ACCOUNT.escrow, name: 'Customer funds held in escrow', type: 'asset', currency, floorMinor: 0 },
    { id: ACCOUNT.settlementBank, name: 'Settlement bank (platform cleared cash)', type: 'asset', currency, floorMinor: 0 },
    { id: ACCOUNT.feeRevenue, name: 'Transaction fee revenue', type: 'revenue', currency },
    { id: ACCOUNT.chargebackLoss, name: 'Refunds absorbed by the platform', type: 'expense', currency },
    { id: ACCOUNT.openingEquity, name: 'Opening balance', type: 'equity', currency },
  ];
  for (const account of accounts) ensureAccount(ledger, account);

  if (config.openingFloatMinor > 0) {
    ledger.post({
      ts: now,
      memo: 'Opening float for the settlement bank',
      code: 'OPENING_BALANCE',
      currency,
      idempotencyKey: `opening:${currency}`,
      postings: [
        { account: ACCOUNT.settlementBank, debit: config.openingFloatMinor, credit: 0 },
        { account: ACCOUNT.openingEquity, debit: 0, credit: config.openingFloatMinor },
      ],
    });
  }
}

export function buyerAccounts(ledger: Ledger, party: string, currency: CurrencyCode): void {
  ensureAccount(ledger, {
    id: ACCOUNT.dueToBuyer(party),
    name: `Held for ${party}`,
    type: 'liability',
    currency,
    party,
    floorMinor: 0,
  });
}

export function sellerAccounts(ledger: Ledger, party: string, currency: CurrencyCode): void {
  ensureAccount(ledger, {
    id: ACCOUNT.dueToSeller(party),
    name: `Payable to ${party}`,
    type: 'liability',
    currency,
    party,
    floorMinor: 0,
  });
}

export interface DepositInput {
  readonly ts: number;
  readonly buyer: string;
  readonly grossMinor: number;
  readonly orderId: string;
  readonly currency: CurrencyCode;
}

/** Buyer funds an order: cash lands in escrow and an equal claim attaches to the buyer. */
export function recordDeposit(ledger: Ledger, input: DepositInput): LedgerEntry {
  buyerAccounts(ledger, input.buyer, input.currency);
  const { entry } = ledger.post({
    ts: input.ts,
    memo: `Escrow hold for order ${input.orderId}`,
    code: 'ESCROW_HOLD',
    currency: input.currency,
    idempotencyKey: `deposit:${input.orderId}`,
    refs: { orderId: input.orderId, buyer: input.buyer },
    postings: [
      { account: ACCOUNT.escrow, debit: input.grossMinor, credit: 0 },
      { account: ACCOUNT.dueToBuyer(input.buyer), debit: 0, credit: input.grossMinor },
    ],
  });
  return entry;
}

export interface CaptureInput {
  readonly ts: number;
  readonly buyer: string;
  readonly seller: string;
  readonly grossMinor: number;
  readonly tradeId: string;
  readonly orderId: string;
  readonly currency: CurrencyCode;
  readonly feeSchedule?: FeeSchedule;
}

export interface CaptureResult {
  readonly entry: LedgerEntry;
  readonly feeMinor: number;
  readonly netMinor: number;
}

/**
 * The sale completes. The buyer's claim is extinguished and re-formed as a payable to the
 * seller, net of the fee the platform recognises as revenue at the same moment. No cash moves
 * here - only the ownership of the cash already sitting in escrow changes.
 */
export function recordCapture(ledger: Ledger, input: CaptureInput): CaptureResult {
  const schedule = input.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  const feeMinor = feeFor(input.grossMinor, schedule);
  const netMinor = input.grossMinor - feeMinor;
  buyerAccounts(ledger, input.buyer, input.currency);
  sellerAccounts(ledger, input.seller, input.currency);

  const postings: Posting[] = [{ account: ACCOUNT.dueToBuyer(input.buyer), debit: input.grossMinor, credit: 0 }];
  if (netMinor > 0) postings.push({ account: ACCOUNT.dueToSeller(input.seller), debit: 0, credit: netMinor });
  if (feeMinor > 0) postings.push({ account: ACCOUNT.feeRevenue, debit: 0, credit: feeMinor });

  const { entry } = ledger.post({
    ts: input.ts,
    memo: `Capture of order ${input.orderId}: net payable to ${input.seller}, fee recognised`,
    code: 'TRADE_CAPTURE',
    currency: input.currency,
    idempotencyKey: `capture:${input.tradeId}`,
    refs: { tradeId: input.tradeId, orderId: input.orderId, buyer: input.buyer, seller: input.seller },
    postings,
  });
  return { entry, feeMinor, netMinor };
}

export interface PayoutInput {
  readonly ts: number;
  readonly seller: string;
  readonly netMinor: number;
  readonly tradeId: string;
  readonly payoutId: string;
  readonly currency: CurrencyCode;
}

/** The seller is paid out of escrow; the payable they carried is discharged. */
export function recordPayout(ledger: Ledger, input: PayoutInput): LedgerEntry {
  sellerAccounts(ledger, input.seller, input.currency);
  const { entry } = ledger.post({
    ts: input.ts,
    memo: `Payout ${input.payoutId} to ${input.seller}`,
    code: 'SELLER_PAYOUT',
    currency: input.currency,
    idempotencyKey: `payout:${input.payoutId}`,
    refs: { payoutId: input.payoutId, tradeId: input.tradeId, seller: input.seller },
    postings: [
      { account: ACCOUNT.dueToSeller(input.seller), debit: input.netMinor, credit: 0 },
      { account: ACCOUNT.escrow, debit: 0, credit: input.netMinor },
    ],
  });
  return entry;
}

/** Sweep the recognised fee out of escrow into the platform's own bank. */
export function recordFeeSweep(ledger: Ledger, input: { ts: number; feeMinor: number; tradeId: string; currency: CurrencyCode }): LedgerEntry {
  const { entry } = ledger.post({
    ts: input.ts,
    memo: `Fee on trade ${input.tradeId} swept to the settlement bank`,
    code: 'PLATFORM_FEE',
    currency: input.currency,
    idempotencyKey: `fee:${input.tradeId}`,
    refs: { tradeId: input.tradeId },
    postings: [
      { account: ACCOUNT.settlementBank, debit: input.feeMinor, credit: 0 },
      { account: ACCOUNT.escrow, debit: 0, credit: input.feeMinor },
    ],
  });
  return entry;
}

export interface RefundInput {
  readonly ts: number;
  readonly buyer: string;
  readonly seller: string;
  /** What we are handing back to the buyer. */
  readonly refundMinor: number;
  readonly tradeId: string;
  readonly refundId: string;
  readonly currency: CurrencyCode;
  /** Fee previously recognised on this trade; reversing it is part of the refund. */
  readonly feeReversalMinor?: number;
  /**
   * Which pocket the cash leaves. `escrow` while the trade's money is still held for the
   * buyer's account; `settlement_bank` once the seller has been paid and the platform has to
   * advance the refund from its own cleared cash.
   */
  readonly source: 'escrow' | 'settlement_bank';
}

export interface RefundResult {
  readonly clawbackEntry: LedgerEntry;
  readonly releaseEntry: LedgerEntry;
  /** What the platform had to absorb because the seller had already been paid out. */
  readonly absorbedMinor: number;
}

/**
 * Refund a captured trade.
 *
 * Two entries, because two things happen: the buyer's claim is rebuilt - clawed back from
 * whatever is still owed to the seller, with the recognised fee reversed, and any shortfall
 * booked explicitly as the platform's own loss - and then the cash is actually handed over.
 * If the funding account does not hold enough, the ledger refuses the entry rather than
 * letting customer money go negative, and the pipeline surfaces it as something a human has
 * to decide about.
 */
export function recordRefund(ledger: Ledger, input: RefundInput): RefundResult {
  const claimAccount = ACCOUNT.dueToBuyer(input.buyer);
  const payableAccount = ACCOUNT.dueToSeller(input.seller);
  const fundingAccount = input.source === 'escrow' ? ACCOUNT.escrow : ACCOUNT.settlementBank;
  ensureAccount(ledger, { id: claimAccount, name: `Held for ${input.buyer}`, type: 'liability', currency: input.currency, party: input.buyer, floorMinor: 0 });
  ensureAccount(ledger, { id: payableAccount, name: `Payable to ${input.seller}`, type: 'liability', currency: input.currency, party: input.seller });
  ensureAccount(ledger, { id: fundingAccount, name: fundingAccount, type: 'asset', currency: input.currency, floorMinor: 0 });

  const payable = Math.max(0, ledger.balanceOf(payableAccount));
  const feeReversal = Math.min(input.feeReversalMinor ?? 0, input.refundMinor);
  const fromPayable = Math.min(payable, input.refundMinor - feeReversal);
  const absorbed = input.refundMinor - feeReversal - fromPayable;

  const clawbackPostings: Posting[] = [{ account: claimAccount, debit: 0, credit: input.refundMinor }];
  if (feeReversal > 0) clawbackPostings.push({ account: ACCOUNT.feeRevenue, debit: feeReversal, credit: 0 });
  if (fromPayable > 0) clawbackPostings.push({ account: payableAccount, debit: fromPayable, credit: 0 });
  if (absorbed > 0) clawbackPostings.push({ account: ACCOUNT.chargebackLoss, debit: absorbed, credit: 0 });

  return ledger.transaction(() => {
    const { entry: clawbackEntry } = ledger.post({
      ts: input.ts,
      memo: `Refund ${input.refundId} rebuilt as the buyer's claim`,
      code: 'REFUND_ISSUED',
      currency: input.currency,
      idempotencyKey: `refund-claim:${input.refundId}`,
      refs: { refundId: input.refundId, tradeId: input.tradeId, buyer: input.buyer, seller: input.seller, source: input.source },
      postings: clawbackPostings,
    });

    const { entry: releaseEntry } = ledger.post({
      ts: input.ts,
      memo: `Refund ${input.refundId} paid out of ${fundingAccount} to ${input.buyer}`,
      code: 'REFUND_ISSUED',
      currency: input.currency,
      idempotencyKey: `refund-cash:${input.refundId}`,
      refs: { refundId: input.refundId, tradeId: input.tradeId, buyer: input.buyer },
      postings: [
        { account: claimAccount, debit: input.refundMinor, credit: 0 },
        { account: fundingAccount, debit: 0, credit: input.refundMinor },
      ],
    });

    return { clawbackEntry, releaseEntry, absorbedMinor: absorbed };
  });
}

export interface VoidInput {
  readonly ts: number;
  readonly buyer: string;
  readonly grossMinor: number;
  readonly orderId: string;
  readonly currency: CurrencyCode;
}

/** An authorised-but-never-captured order releases the buyer's claim; no fee is earned. */
export function recordVoid(ledger: Ledger, input: VoidInput): LedgerEntry {
  buyerAccounts(ledger, input.buyer, input.currency);
  const { entry } = ledger.post({
    ts: input.ts,
    memo: `Order ${input.orderId} voided, escrow released unredeemed`,
    code: 'ORDER_VOIDED',
    currency: input.currency,
    idempotencyKey: `void:${input.orderId}`,
    refs: { orderId: input.orderId, buyer: input.buyer },
    postings: [
      { account: ACCOUNT.dueToBuyer(input.buyer), debit: input.grossMinor, credit: 0 },
      { account: ACCOUNT.escrow, debit: 0, credit: input.grossMinor },
    ],
  });
  return entry;
}

export type { EntryCode };
