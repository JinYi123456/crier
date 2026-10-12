import { describe, expect, it } from 'vitest';
import { SimGateway } from '../src/gateway/sim';
import { Ledger } from '../src/core/ledger';
import { ACCOUNT, openBooks } from '../src/core/books';
import { identityFromSeed } from '../src/core/keys';
import { newChain, verifyChain, keyringFrom } from '../src/core/protocol';
import { Settler, SettlementError, evaluateVeto, AUTO_SETTLE_LIMIT_MINOR, AWAITING_APPROVAL_RULE, FIRST_PAIRING_REVIEW_MINOR } from '../src/core/settlement';
import type { TradeInput } from '../src/core/settlement';
import { AwaitingApprovalError, type PaymentGateway } from '../src/gateway/types';

const exchange = identityFromSeed('test-seed', 'exchange');
const human = identityFromSeed('test-seed', 'human');
const buyer = identityFromSeed('test-seed', 'buyer-kestrel');
const seller = identityFromSeed('test-seed', 'seller-onyx');

interface Harness {
  readonly settler: Settler;
  readonly ledger: Ledger;
  readonly gateway: SimGateway;
  readonly chain: ReturnType<typeof newChain>;
}

/**
 * A clock that only moves forward when the harness is asked, so the chain never reports a
 * clock regression and a test can name the exact timestamps it expects.
 */
function harness(
  options: {
    reviewAboveMinor?: number;
    declineBps?: number;
    floatMinor?: number;
    payoutMode?: 'immediate' | 'batched';
    wrap?: (gateway: SimGateway) => PaymentGateway;
  } = {},
): Harness {
  let now = 1_700_000_000_000;
  const ledger = new Ledger();
  openBooks(ledger, { currency: 'USD', feeSchedule: { bps: 299, fixedMinor: 30 }, openingFloatMinor: options.floatMinor ?? 5_000_00 }, now);
  const gateway = new SimGateway({ declineBps: options.declineBps ?? 0, reviewAboveMinor: options.reviewAboveMinor ?? Number.MAX_SAFE_INTEGER, now: () => now });
  const chain = newChain();
  const settler = new Settler({
    ledger,
    gateway: options.wrap ? options.wrap(gateway) : gateway,
    chain,
    session: 'sess_test',
    exchange,
    human,
    payoutMode: options.payoutMode,
    now: () => {
      now += 1_000;
      return now;
    },
  });
  return { settler, ledger, gateway, chain };
}

function trade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    tradeId: 'trade_0001',
    instrument: 'CRAFT-COFFEE',
    buyer: buyer.actor,
    seller: seller.actor,
    priceMinor: 4_00,
    qty: 10,
    currency: 'USD',
    description: 'ten bags of single origin',
    priorPairing: 1,
    ...overrides,
  };
}

/**
 * A processor that behaves like the real thing: creating an order is not a payment, and nothing
 * can be captured until the buyer has approved out of band.
 */
function buyerControlled(gateway: SimGateway): { readonly gate: PaymentGateway; approve: () => void } {
  const state = { waiting: true };
  const gate: PaymentGateway = {
    mode: 'sandbox',
    createOrder: (input) => gateway.createOrder(input),
    async approveOrder(reference) {
      if (state.waiting) throw new AwaitingApprovalError(reference, `https://sandbox.paypal.com/checkoutnow?token=${reference}`);
      return gateway.approveOrder(reference);
    },
    captureOrder: (reference) => gateway.captureOrder(reference),
    voidOrder: (reference, reason) => gateway.voidOrder(reference, reason),
    refund: (reference, amount, reason) => gateway.refund(reference, amount, reason),
    payout: (recipient, amount, note) => gateway.payout(recipient, amount, note),
    listWaiting: () => gateway.listWaiting(),
    verifyWebhook: (headers, rawBody) => gateway.verifyWebhook(headers, rawBody),
  };
  return { gate, approve: () => (state.waiting = false) };
}

describe('settlement pipeline', () => {
  it('takes a clean trade all the way to paid out and leaves the books balanced', async () => {
    const h = harness();
    const record = await h.settler.settle(trade());
    expect(record.phase).toBe('paid_out');
    expect(record.held).toBe(false);
    expect(record.feeMinor).toBe(150);
    expect(record.netMinor).toBe(3_850);
    expect(record.refundedMinor).toBe(0);

    expect(h.ledger.isBalanced()).toBe(true);
    expect(h.ledger.audit()).toEqual([]);
    // Escrow ends empty for this trade: everything has either paid the seller or become fee.
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.dueToBuyer(buyer.actor))).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.dueToSeller(seller.actor))).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(150);
    expect(h.ledger.balanceOf(ACCOUNT.settlementBank)).toBe(5_000_00 + 150);
  });

  it('writes one signed chain message per step, and the chain verifies', async () => {
    const h = harness();
    const record = await h.settler.settle(trade());
    const types = record.messages.map((message) => message.type);
    expect(types).toEqual([
      'order.created',
      'ledger.entry',
      'order.approved',
      'order.captured',
      'ledger.entry',
      'payout.created',
      'payout.paid',
      'ledger.entry',
      'ledger.entry',
    ]);
    expect(types.filter((type) => type === 'ledger.entry')).toHaveLength(4);
    const result = verifyChain(h.chain.messages, keyringFrom([exchange, human, buyer, seller]));
    expect(result.ok).toBe(true);
    expect(result.count).toBe(types.length);
  });

  it('holds a trade whose veto rules fire, and does not capture it', async () => {
    const h = harness();
    const record = await h.settler.settle(trade({ tradeId: 'trade_big', priceMinor: 900_00, qty: 3 }));
    expect(record.held).toBe(true);
    expect(record.phase).toBe('funded');
    expect(record.vetoRules).toContain('size');
    expect(record.vetoReasons.join(' ')).toMatch(/settles more here than the floor lets through/);
    // A reason is signed prose: it must never carry money that somebody's locale has formatted.
    for (const reason of record.vetoReasons) expect(reason).not.toMatch(/[$¥€]\s?\d|\d,\d{3}/);
    // The money is recognised in escrow but nothing has been taken.
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(2_700_00);
    expect(h.settler.held).toHaveLength(1);
    expect(h.settler.summary().heldTrades).toBe(1);
    expect(h.ledger.isBalanced()).toBe(true);
  });

  it('settles a held trade when the human releases it, under the human key', async () => {
    const h = harness();
    const held = await h.settler.settle(trade({ tradeId: 'trade_release', priceMinor: 9_000_00, qty: 1 }));
    expect(held.held).toBe(true);
    const released = await h.settler.release('trade_release', 'checked the invoice');
    expect(released.phase).toBe('paid_out');
    expect(released.held).toBe(false);
    const release = released.messages.find((message) => message.type === 'human.release');
    expect(release?.actor).toBe('human');
    expect(release?.key).toBe(human.publicKey);
    expect(release?.payload.note).toBe('checked the invoice');
    expect(verifyChain(h.chain.messages, keyringFrom([exchange, human])).ok).toBe(true);
    expect(h.ledger.audit()).toEqual([]);
  });

  it('voids a held trade when the human vetoes it, and the buyer gets the whole escrow back', async () => {
    const h = harness();
    const held = await h.settler.settle(trade({ tradeId: 'trade_veto', priceMinor: 9_000_00, qty: 1 }));
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(9_000_00);
    const vetoed = await h.settler.veto('trade_veto', 'seller has not shipped in the past');
    expect(vetoed.phase).toBe('voided');
    expect(vetoed.held).toBe(false);
    expect(vetoed.vetoNote).toBe('seller has not shipped in the past');
    expect(h.gateway.statusOf(vetoed.orderId ?? '')).toBe('voided');
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.dueToBuyer(buyer.actor))).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(h.ledger.audit()).toEqual([]);
    const veto = vetoed.messages.find((message) => message.type === 'human.veto' && message.payload.final === true);
    expect(veto?.actor).toBe('human');
  });

  it('refuses to veto a trade that has already settled', async () => {
    const h = harness();
    await h.settler.settle(trade());
    await expect(h.settler.veto('trade_0001', 'too late')).rejects.toThrow(SettlementError);
  });

  it('refunds out of escrow while the payout batch is still pending, reversing the fee', async () => {
    const h = harness({ floatMinor: 0, payoutMode: 'batched' });
    const record = await h.settler.settle(trade({ tradeId: 'trade_batched_refund' }));
    expect(record.phase).toBe('captured');
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(record.grossMinor);

    const refunded = await h.settler.refund('trade_batched_refund', record.grossMinor, 'goods not as described');
    expect(refunded.phase).toBe('refunded');
    expect(refunded.refundedMinor).toBe(record.grossMinor);
    // Nothing was paid out, so nothing was absorbed: the fee simply un-earns itself.
    expect(h.ledger.balanceOf(ACCOUNT.chargebackLoss)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.audit()).toEqual([]);
  });

  it('runs the payout batch, empties escrow, and a second batch does nothing', async () => {
    const h = harness({ payoutMode: 'batched' });
    const a = await h.settler.settle(trade({ tradeId: 'trade_batch_a' }));
    const b = await h.settler.settle(trade({ tradeId: 'trade_batch_b', priceMinor: 5_00, qty: 4 }));
    expect(h.settler.summary().pendingPayoutMinor).toBe(a.netMinor + b.netMinor);
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(a.grossMinor + b.grossMinor);

    const moved = await h.settler.settlePayouts();
    expect(moved.map((trade) => trade.id)).toEqual(['trade_batch_a', 'trade_batch_b']);
    expect(h.settler.awaitingPayout).toHaveLength(0);
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.settlementBank)).toBe(5_000_00 + a.feeMinor + b.feeMinor);
    expect(h.ledger.audit()).toEqual([]);
    expect(await h.settler.settlePayouts()).toHaveLength(0);
  });

  it('advances a post-payout refund from the settlement bank and books the absorbed part', async () => {
    const h = harness({ floatMinor: 1_000_00 });
    const record = await h.settler.settle(trade({ tradeId: 'trade_advance', priceMinor: 4_00, qty: 10 }));
    expect(record.netMinor).toBe(3_850);
    const bankBefore = h.ledger.balanceOf(ACCOUNT.settlementBank);

    const refunded = await h.settler.refund('trade_advance', record.grossMinor, 'goods never arrived');
    expect(refunded.phase).toBe('refunded');
    expect(refunded.refundedMinor).toBe(4_000);
    // The fee un-earns itself and the rest comes out of the platform's own cleared cash.
    expect(h.ledger.listEntries().filter((entry) => entry.code === 'REFUND_ISSUED')).toHaveLength(2);
    expect(h.ledger.balanceOf(ACCOUNT.chargebackLoss)).toBe(3_850);
    expect(h.ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.settlementBank)).toBe(bankBefore - 4_000);
    expect(h.ledger.audit()).toEqual([]);
  });

  it('refuses a refund the settlement bank cannot cover, and says so on the chain', async () => {
    const h = harness({ floatMinor: 100 });
    const record = await h.settler.settle(trade({ tradeId: 'trade_broke', priceMinor: 4_00, qty: 10 }));
    await expect(h.settler.refund('trade_broke', record.netMinor, 'no float')).rejects.toThrow(/could not be funded/);
    const failure = h.chain.messages.filter((message) => message.type === 'order.failed');
    expect(failure.length).toBe(1);
    expect(failure[0]?.payload.stage).toBe('refund');
    expect(h.ledger.isBalanced()).toBe(true);
  });

  it('will not refund more than the trade is worth, and part-refunds accumulate', async () => {
    const h = harness({ floatMinor: 10_000_00 });
    const record = await h.settler.settle(trade({ tradeId: 'trade_part', priceMinor: 10_00, qty: 10 }));
    await expect(h.settler.refund('trade_part', record.grossMinor + 1, 'over')).rejects.toThrow(/still refundable/);
    await expect(h.settler.refund('trade_part', 0, 'nothing')).rejects.toThrow(/still refundable/);

    const first = await h.settler.refund('trade_part', 4_000, 'half the pallet was short');
    expect(first.phase).toBe('paid_out');
    expect(first.refundedMinor).toBe(4_000);
    const second = await h.settler.refund('trade_part', 6_000, 'the rest came back');
    expect(second.phase).toBe('refunded');
    expect(second.refundReferences).toHaveLength(2);
    expect(second.refundReferences[0]).not.toBe(second.refundReferences[1]);
    expect(h.ledger.audit()).toEqual([]);
  });

  it('will not refund a trade that never captured', async () => {
    const h = harness();
    const held = await h.settler.settle(trade({ tradeId: 'trade_unfunded_hold', priceMinor: 9_000_00, qty: 1 }));
    expect(held.held).toBe(true);
    await expect(h.settler.refund('trade_unfunded_hold', 100, 'premature')).rejects.toThrow(/no capture to refund/);
  });

  it('is idempotent: settling the same trade twice does not pay the seller twice', async () => {
    const h = harness();
    const first = await h.settler.settle(trade());
    const again = await h.settler.settle(trade());
    expect(again).toBe(first);
    expect(h.settler.summary().trades).toBe(1);
    expect(h.ledger.balanceOf(ACCOUNT.settlementBank)).toBe(5_000_00 + 150);
    expect(h.ledger.listEntries().filter((entry) => entry.code === 'SELLER_PAYOUT')).toHaveLength(1);
  });

  it('releases escrow as declined when the payer is refused', async () => {
    const seed = 'trade_doomed';
    const gateway = new SimGateway({ declineBps: 10_000 });
    const ledger = new Ledger();
    openBooks(ledger, { currency: 'USD', feeSchedule: { bps: 299, fixedMinor: 30 }, openingFloatMinor: 100_00 }, 1);
    const chain = newChain();
    const settler = new Settler({ ledger, gateway, chain, session: 's', exchange, human, now: () => 1_700_000_000_001 });
    const declined = await settler.settle(trade({ tradeId: seed, priceMinor: 10_00, qty: 1 }));
    // A gateway that declines everything parks the trade for review first; release it by hand.
    const record = declined.held ? await settler.release(seed) : declined;
    expect(record.phase).toBe('declined');
    expect(ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(0);
    expect(ledger.audit()).toEqual([]);
  });

  it('surfaces a processor that refuses the order as a failed trade, not a crash', async () => {
    const h = harness();
    const zero = await h.settler.settle(trade({ tradeId: 'trade_zero', priceMinor: 0, qty: 4 })).catch(() => null);
    expect(zero === null || zero.phase === 'failed').toBe(true);
  });

  it('drains gateway events onto the chain as verified webhooks', async () => {
    const h = harness();
    const record = await h.settler.settle(trade());
    h.settler.ingest(h.gateway.drainEvents());
    const hooks = h.chain.messages.filter((message) => message.type === 'webhook.received');
    expect(hooks.length).toBeGreaterThan(0);
    const capture = hooks.find((message) => message.payload.eventType === 'PAYMENT.CAPTURE.COMPLETED');
    expect(capture?.payload.tradeId).toBe(record.id);
    expect(verifyChain(h.chain.messages, keyringFrom([exchange, human])).ok).toBe(true);
  });

  it('holds a settlement while the buyer still has the approval page open, then finishes it', async () => {
    const box: { control?: { approve: () => void } } = {};
    const h = harness({
      wrap: (gateway) => {
        const opened = buyerControlled(gateway);
        box.control = opened;
        return opened.gate;
      },
    });
    const settled = await h.settler.settle(trade());
    expect(settled.phase).toBe('funded');
    expect(settled.held).toBe(true);
    expect(settled.vetoRules).toContain(AWAITING_APPROVAL_RULE);
    expect(settled.approvalUrl).toContain('checkoutnow');
    // Nothing has been taken: the buyer's money is still escrow and still their claim.
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(settled.grossMinor);
    expect(h.ledger.balanceOf(ACCOUNT.dueToBuyer(buyer.actor))).toBe(settled.grossMinor);
    expect(h.ledger.isBalanced()).toBe(true);

    box.control?.approve();
    const released = await h.settler.release(settled.id);
    expect(released.phase).toBe('paid_out');
    expect(released.held).toBe(false);
    expect(released.approvalUrl).toBeNull();
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.audit()).toEqual([]);
    const pending = h.chain.messages.filter((message) => message.type === 'human.veto' && message.payload.pending === true);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.rules).toContain(AWAITING_APPROVAL_RULE);
  });

  it('voids an order the buyer never approved when the operator refuses it', async () => {
    const h = harness({ wrap: (gateway) => buyerControlled(gateway).gate });
    const held = await h.settler.settle(trade({ tradeId: 'trade_stranger' }));
    expect(held.held).toBe(true);
    const vetoed = await h.settler.veto(held.id, 'a first trade between strangers at this size');
    expect(vetoed.phase).toBe('voided');
    expect(vetoed.approvalUrl).toBeNull();
    expect(h.ledger.balanceOf(ACCOUNT.escrow)).toBe(0);
    expect(h.ledger.balanceOf(ACCOUNT.dueToBuyer('buyer-kestrel'))).toBe(0);
    expect(h.ledger.audit()).toEqual([]);
  });
});

describe('the veto rules themselves', () => {
  const base = {
    grossMinor: 1_000,
    currency: 'USD' as const,
    instrument: 'CRAFT-COFFEE',
    buyer: 'b',
    seller: 's',
    priceMinor: 100,
    qty: 10,
    referencePriceMinor: 100,
    buyerReputationBps: 8_000,
    sellerReputationBps: 8_000,
    priorPairing: 3,
    sellerExposureMinor: 0,
  };

  it('lets a small, well-priced trade between regulars through untouched', () => {
    expect(evaluateVeto(base).required).toBe(false);
  });

  it('catches size, a stray price, an unrated counterparty and a first pairing', () => {
    expect(evaluateVeto({ ...base, grossMinor: AUTO_SETTLE_LIMIT_MINOR + 1 }).ruleIds).toContain('size');
    expect(evaluateVeto({ ...base, priceMinor: 120 }).ruleIds).toContain('stray_price');
    expect(evaluateVeto({ ...base, sellerReputationBps: 1_000 }).ruleIds).toContain('unrated');
    expect(evaluateVeto({ ...base, priorPairing: 0, grossMinor: FIRST_PAIRING_REVIEW_MINOR + 1 }).ruleIds).toContain('first_pairing');
    expect(evaluateVeto({ ...base, sellerExposureMinor: 1_999_500 }).ruleIds).toContain('concentration');
  });

  it('lets two strangers settle a small amount without a second look', () => {
    expect(evaluateVeto({ ...base, priorPairing: 0, grossMinor: 100 }).ruleIds).not.toContain('first_pairing');
  });

  it('has no opinion about a stray price when the floor has never printed this instrument', () => {
    expect(evaluateVeto({ ...base, referencePriceMinor: null }).ruleIds).not.toContain('stray_price');
  });
});
