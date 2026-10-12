import { derivedId } from './canonical';
import {
  ACCOUNT,
  DEFAULT_FEE_SCHEDULE,
  feeFor,
  recordCapture,
  recordDeposit,
  recordFeeSweep,
  recordPayout,
  recordRefund,
  recordVoid,
  type FeeSchedule,
} from './books';
import { Ledger, LedgerError, type LedgerEntry } from './ledger';
import { assertMinor, type CurrencyCode } from './money';
import type { Identity } from './keys';
import { append, type ChainState, type MessageType, type SealedMessage } from './protocol';
import { AwaitingApprovalError, GatewayError, type GatewayEvent, type PaymentGateway, type PaymentOrder } from '../gateway/types';

/**
 * From a print on the board to money in the seller's account.
 *
 * A fill is only a promise. This is where the promise becomes a payment: escrow is funded, the
 * processor is asked to capture, the books record the fee, the seller is paid, and a refund
 * walks the same path in reverse. Every step is idempotent, because settlement gets retried -
 * by us, by the processor, by an operator watching a stuck trade - and a retry must never pay
 * anybody twice.
 *
 * The veto layer sits in front of capture, not in front of matching. Agents may shout whatever
 * they like and the book will match any crossing pair; what a human decides is whether the
 * platform is willing to move money on the back of it. That is the honest position: the trade
 * has already happened, the question is settlement.
 */

export type TradePhase =
  | 'matched'
  | 'funded'
  | 'captured'
  | 'paid_out'
  | 'voided'
  | 'declined'
  | 'refunded'
  | 'failed';

const OPEN_PHASES: readonly TradePhase[] = ['matched', 'funded', 'captured', 'paid_out'];

export function isOpen(phase: TradePhase): boolean {
  return OPEN_PHASES.includes(phase);
}

const CAPTURED_PHASES: readonly TradePhase[] = ['captured', 'paid_out', 'refunded'];

export interface VetoContext {
  readonly grossMinor: number;
  readonly currency: CurrencyCode;
  readonly instrument: string;
  readonly buyer: string;
  readonly seller: string;
  readonly priceMinor: number;
  readonly qty: number;
  /** The last print on this instrument, if the floor has one - the reference for a stray price. */
  readonly referencePriceMinor: number | null;
  readonly buyerReputationBps: number;
  readonly sellerReputationBps: number;
  /** Trades already settled between this exact pair. */
  readonly priorPairing: number;
  /** Minor units already released to this seller in the session. */
  readonly sellerExposureMinor: number;
}

export interface VetoRule {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  check(context: VetoContext): string | null;
}

export interface VetoDecision {
  readonly required: boolean;
  readonly ruleIds: string[];
  readonly reasons: string[];
}

/**
 * Five questions an operator would actually ask about a print before agreeing to settle it.
 * The thresholds are the ones the pit screen shows next to each card.
 */
export const AUTO_SETTLE_LIMIT_MINOR = 2_500_00;
export const STRAY_PRICE_BPS = 1_500;
export const MIN_REPUTATION_BPS = 3_000;
export const SESSION_EXPOSURE_CAP_MINOR = 2_000_00;
/** Most trades on a floor are between strangers, so only a large first ticket earns a look. */
export const FIRST_PAIRING_REVIEW_MINOR = 1_000_00;
/**
 * Not one of our rules - the processor's own hold, reported as if it were one. A live order the
 * buyer has not approved is exactly as un-settled as a trade an operator has not signed off, and
 * putting both on the same pile is what makes the queue worth reading.
 */
export const AWAITING_APPROVAL_RULE = 'awaiting_approval';

export const DEFAULT_VETO_RULES: readonly VetoRule[] = [
  {
    id: 'size',
    label: 'Size above the auto-settle limit',
    hint: 'Large settlements are the ones nobody wants to explain later.',
    check: (context) =>
      context.grossMinor > AUTO_SETTLE_LIMIT_MINOR
        ? `${context.instrument} settles more here than the floor lets through on its own`
        : null,
  },
  {
    id: 'stray_price',
    label: 'Price far from the last print',
    hint: 'A fill well away from the board is usually a stale quote or a mistake.',
    check: (context) => {
      if (context.referencePriceMinor === null || context.referencePriceMinor <= 0) return null;
      const deviationBps = Math.round((Math.abs(context.priceMinor - context.referencePriceMinor) * 10_000) / context.referencePriceMinor);
      return deviationBps > STRAY_PRICE_BPS
        ? `this fill on ${context.instrument} sits ${deviationBps} bps from the last print`
        : null;
    },
  },
  {
    id: 'unrated',
    label: 'Counterparty without standing',
    hint: 'Fresh principals get looked at; a floor regular does not.',
    check: (context) => {
      const weakest = Math.min(context.buyerReputationBps, context.sellerReputationBps);
      return weakest < MIN_REPUTATION_BPS ? `the least reputable side of this pairing stands at ${weakest} bps` : null;
    },
  },
  {
    id: 'first_pairing',
    label: 'First trade between this pair',
    hint: 'Two strangers settling a real amount is the one worth reading; pocket change can go through.',
    check: (context) =>
      context.priorPairing === 0 && context.grossMinor > FIRST_PAIRING_REVIEW_MINOR
        ? `${context.buyer} and ${context.seller} have never settled together on this floor`
        : null,
  },
  {
    id: 'concentration',
    label: 'Seller exposure over the session cap',
    hint: 'Too much value flowing to one account in one session is a pattern, not a coincidence.',
    check: (context) =>
      context.sellerExposureMinor + context.grossMinor > SESSION_EXPOSURE_CAP_MINOR
        ? `${context.seller} would take more of this session than one account should`
        : null,
  },
];

export function evaluateVeto(context: VetoContext, rules: readonly VetoRule[] = DEFAULT_VETO_RULES): VetoDecision {
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  for (const rule of rules) {
    const reason = rule.check(context);
    if (reason !== null) {
      ruleIds.push(rule.id);
      reasons.push(reason);
    }
  }
  return { required: ruleIds.length > 0, ruleIds, reasons };
}

export interface TradeInput {
  readonly tradeId: string;
  readonly instrument: string;
  readonly buyer: string;
  readonly seller: string;
  readonly priceMinor: number;
  readonly qty: number;
  readonly currency: CurrencyCode;
  readonly referencePriceMinor?: number | null;
  readonly buyerReputationBps?: number;
  readonly sellerReputationBps?: number;
  readonly priorPairing?: number;
  readonly sellerExposureMinor?: number;
  readonly description: string;
}

export interface TradeStep {
  readonly phase: TradePhase;
  readonly at: number;
  readonly note: string;
}

export interface TradeRecord {
  readonly id: string;
  readonly instrument: string;
  readonly buyer: string;
  readonly seller: string;
  readonly priceMinor: number;
  readonly qty: number;
  readonly grossMinor: number;
  readonly currency: CurrencyCode;
  phase: TradePhase;
  feeMinor: number;
  netMinor: number;
  refundedMinor: number;
  orderId: string | null;
  captureReference: string | null;
  payoutReference: string | null;
  refundReferences: string[];
  readonly createdAt: number;
  updatedAt: number;
  held: boolean;
  vetoRules: string[];
  vetoReasons: string[];
  /** Where the buyer approves a live order, while the processor is still waiting for them. */
  approvalUrl: string | null;
  vetoNote: string | null;
  failure: string | null;
  steps: TradeStep[];
  entries: LedgerEntry[];
  messages: SealedMessage[];
}

export class SettlementError extends Error {
  readonly tradeId: string;
  constructor(message: string, tradeId: string) {
    super(message);
    this.name = 'SettlementError';
    this.tradeId = tradeId;
  }
}

export interface SettlerDeps {
  readonly ledger: Ledger;
  readonly gateway: PaymentGateway;
  readonly chain: ChainState;
  readonly session: string;
  /** The platform's own principal - it signs everything that is not a party speaking. */
  readonly exchange: Identity;
  /** The human on the floor. Their key signs a release or a veto, so it is not our claim. */
  readonly human: Identity;
  readonly feeSchedule?: FeeSchedule;
  readonly vetoRules?: readonly VetoRule[];
  /**
   * `immediate` pays the seller as soon as the capture lands. `batched` leaves the money in
   * escrow as a payable and waits for `settlePayouts`, which is what a real facilitator does -
   * payouts go out in a daily batch, and a dispute raised before the batch is much cheaper to
   * answer than one raised after it.
   */
  readonly payoutMode?: 'immediate' | 'batched';
  readonly now: () => number;
}

export interface SettlerSummary {
  readonly trades: number;
  readonly grossMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly refundedMinor: number;
  readonly pendingPayoutMinor: number;
  readonly byPhase: Readonly<Partial<Record<TradePhase, number>>>;
  readonly heldTrades: number;
}

export class Settler {
  private readonly trades = new Map<string, TradeRecord>();
  private readonly order: string[] = [];
  private readonly deps: SettlerDeps;
  private readonly feeSchedule: FeeSchedule;
  private readonly rules: readonly VetoRule[];
  private readonly payoutMode: 'immediate' | 'batched';

  constructor(deps: SettlerDeps) {
    this.deps = deps;
    this.feeSchedule = deps.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
    this.rules = deps.vetoRules ?? DEFAULT_VETO_RULES;
    this.payoutMode = deps.payoutMode ?? 'immediate';
  }

  get all(): TradeRecord[] {
    return this.order.map((id) => this.mustGet(id));
  }

  get held(): TradeRecord[] {
    return this.all.filter((trade) => trade.held);
  }

  get settled(): TradeRecord[] {
    return this.all.filter((trade) => trade.phase === 'paid_out');
  }

  /** Captured and waiting in escrow for the payout batch. */
  get awaitingPayout(): TradeRecord[] {
    return this.all.filter((trade) => trade.phase === 'captured');
  }

  summary(): SettlerSummary {
    const byPhase: Partial<Record<TradePhase, number>> = {};
    let gross = 0;
    let fee = 0;
    let net = 0;
    let refunded = 0;
    let pendingPayout = 0;
    for (const trade of this.all) {
      byPhase[trade.phase] = (byPhase[trade.phase] ?? 0) + 1;
      if (isOpen(trade.phase)) gross += trade.grossMinor;
      refunded += trade.refundedMinor;
      if (trade.phase === 'captured') pendingPayout += trade.netMinor;
      if (CAPTURED_PHASES.includes(trade.phase)) {
        fee += trade.feeMinor;
        net += trade.netMinor;
      }
    }
    return {
      trades: this.order.length,
      grossMinor: gross,
      feeMinor: fee,
      netMinor: net,
      refundedMinor: refunded,
      pendingPayoutMinor: pendingPayout,
      byPhase,
      heldTrades: this.held.length,
    };
  }

  get(tradeId: string): TradeRecord | undefined {
    return this.trades.get(tradeId);
  }

  private mustGet(tradeId: string): TradeRecord {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new SettlementError(`unknown trade ${tradeId}`, tradeId);
    return trade;
  }

  private say(trade: TradeRecord, type: MessageType, payload: Record<string, unknown>, actor: Identity = this.deps.exchange): void {
    trade.messages.push(append(this.deps.chain, this.deps.session, actor, type, { tradeId: trade.id, ...payload }, this.deps.now()));
  }

  private step(trade: TradeRecord, phase: TradePhase, note: string): void {
    trade.phase = phase;
    trade.updatedAt = this.deps.now();
    trade.steps.push({ phase, at: trade.updatedAt, note });
  }

  /**
   * Match to settlement, as far as it can go without a human.
   *
   * Escrow is recognised first: we do not ask the processor to capture money that is not yet
   * on our books as somebody's claim.
   */
  async settle(input: TradeInput): Promise<TradeRecord> {
    const existing = this.trades.get(input.tradeId);
    if (existing) return existing;

    const gross = assertMinor(input.priceMinor * input.qty, 'trade gross');
    const now = this.deps.now();
    const trade: TradeRecord = {
      id: input.tradeId,
      instrument: input.instrument,
      buyer: input.buyer,
      seller: input.seller,
      priceMinor: input.priceMinor,
      qty: input.qty,
      grossMinor: gross,
      currency: input.currency,
      phase: 'matched',
      feeMinor: 0,
      netMinor: 0,
      refundedMinor: 0,
      orderId: null,
      captureReference: null,
      payoutReference: null,
      refundReferences: [],
      createdAt: now,
      updatedAt: now,
      held: false,
      vetoRules: [],
      vetoReasons: [],
      approvalUrl: null,
      vetoNote: null,
      failure: null,
      steps: [],
      entries: [],
      messages: [],
    };
    this.trades.set(trade.id, trade);
    this.order.push(trade.id);

    const decision = evaluateVeto(
      {
        grossMinor: gross,
        currency: input.currency,
        instrument: input.instrument,
        buyer: input.buyer,
        seller: input.seller,
        priceMinor: input.priceMinor,
        qty: input.qty,
        referencePriceMinor: input.referencePriceMinor ?? null,
        buyerReputationBps: input.buyerReputationBps ?? 10_000,
        sellerReputationBps: input.sellerReputationBps ?? 10_000,
        priorPairing: input.priorPairing ?? 0,
        sellerExposureMinor: input.sellerExposureMinor ?? 0,
      },
      this.rules,
    );
    trade.vetoRules = decision.ruleIds;
    trade.vetoReasons = decision.reasons;
    trade.held = decision.required;

    let order;
    try {
      order = await this.deps.gateway.createOrder({
        tradeId: trade.id,
        amountMinor: gross,
        currency: input.currency,
        buyer: input.buyer,
        seller: input.seller,
        description: `${input.qty} x ${input.instrument} at ${input.priceMinor} - ${input.description}`,
        invoiceNumber: `CRIER-${derivedId('inv', trade.id).slice(4, 12).toUpperCase()}`,
      });
    } catch (error) {
      trade.failure = messageOf(error);
      this.step(trade, 'failed', `the processor refused the order: ${trade.failure}`);
      this.say(trade, 'order.failed', { stage: 'create', error: trade.failure });
      return trade;
    }
    trade.orderId = order.reference;

    const deposit = recordDeposit(this.deps.ledger, {
      ts: this.deps.now(),
      buyer: input.buyer,
      grossMinor: gross,
      orderId: order.reference,
      currency: input.currency,
    });
    trade.entries.push(deposit);
    this.step(trade, 'funded', `order ${order.reference} created and the buyer's money held in escrow`);
    this.say(trade, 'order.created', {
      orderId: order.reference,
      grossMinor: gross,
      currency: input.currency,
      instrument: input.instrument,
      buyer: input.buyer,
      seller: input.seller,
      priceMinor: input.priceMinor,
      qty: input.qty,
    });
    this.tellEntries(trade, [deposit]);

    if (trade.held) {
      this.say(trade, 'human.veto', {
        pending: true,
        rules: trade.vetoRules.join(','),
        reasons: trade.vetoReasons.join(' | '),
        grossMinor: gross,
      });
      return trade;
    }

    await this.capture(trade);
    return trade;
  }

  /** The human let it through. */
  async release(tradeId: string, note = 'released by the floor operator'): Promise<TradeRecord> {
    const trade = this.mustGet(tradeId);
    if (!trade.held) throw new SettlementError(`trade ${tradeId} is not waiting on a human`, tradeId);
    trade.held = false;
    this.say(trade, 'human.release', { note, grossMinor: trade.grossMinor }, this.deps.human);
    await this.capture(trade);
    return trade;
  }

  /** The human refused it: the order is voided and the buyer's money goes back unredeemed. */
  async veto(tradeId: string, note: string): Promise<TradeRecord> {
    const trade = this.mustGet(tradeId);
    if (!trade.held || trade.phase !== 'funded') {
      throw new SettlementError(`trade ${tradeId} is ${trade.phase} - it has moved past a veto`, tradeId);
    }
    trade.vetoNote = note;
    trade.held = false;
    trade.approvalUrl = null;
    this.say(trade, 'human.veto', { note, grossMinor: trade.grossMinor, final: true }, this.deps.human);
    if (!trade.orderId) throw new SettlementError(`trade ${tradeId} has no order to void`, tradeId);

    const voided = await this.deps.gateway.voidOrder(trade.orderId, note);
    const entry = recordVoid(this.deps.ledger, {
      ts: this.deps.now(),
      buyer: trade.buyer,
      grossMinor: trade.grossMinor,
      orderId: voided.reference,
      currency: trade.currency,
    });
    trade.entries.push(entry);
    this.step(trade, 'voided', `vetoed: ${note}`);
    this.say(trade, 'order.voided', { orderId: voided.reference, grossMinor: voided.gross.amountMinor, reason: note });
    this.tellEntries(trade, [entry]);
    return trade;
  }

  /** Approve, capture, recognise the fee, pay the seller. Idempotent at every step. */
  private async capture(trade: TradeRecord): Promise<void> {
    if (!trade.orderId) throw new SettlementError(`trade ${trade.id} was never funded`, trade.id);
    if (trade.phase !== 'funded') return;

    let approved: PaymentOrder;
    try {
      approved = await this.deps.gateway.approveOrder(trade.orderId);
    } catch (error) {
      if (error instanceof AwaitingApprovalError) {
        this.awaitBuyer(trade, error.approvalUrl);
        return;
      }
      throw error;
    }
    trade.approvalUrl = null;
    if (approved.status === 'declined') {
      const reason = approved.declinedReason ?? 'declined';
      this.say(trade, 'order.failed', { stage: 'approve', orderId: approved.reference, reason });
      const entry = recordVoid(this.deps.ledger, {
        ts: this.deps.now(),
        buyer: trade.buyer,
        grossMinor: trade.grossMinor,
        orderId: approved.reference,
        currency: trade.currency,
      });
      trade.entries.push(entry);
      this.step(trade, 'declined', `the payer's funding source refused: ${reason}`);
      this.tellEntries(trade, [entry]);
      return;
    }
    this.say(trade, 'order.approved', { orderId: approved.reference, grossMinor: approved.gross.amountMinor });

    const captured = await this.deps.gateway.captureOrder(approved.reference);
    trade.captureReference = captured.captureReference ?? null;

    const before = this.deps.ledger.size;
    const { feeMinor, netMinor } = recordCapture(this.deps.ledger, {
      ts: this.deps.now(),
      buyer: trade.buyer,
      seller: trade.seller,
      grossMinor: trade.grossMinor,
      tradeId: trade.id,
      orderId: captured.reference,
      currency: trade.currency,
      feeSchedule: this.feeSchedule,
    });
    trade.feeMinor = feeMinor;
    trade.netMinor = netMinor;
    const captureEntries = this.deps.ledger.listEntries().slice(before);
    trade.entries.push(...captureEntries);

    this.step(trade, 'captured', `captured against ${captured.reference}; the fee is booked and the seller is owed the net`);
    this.say(trade, 'order.captured', {
      orderId: captured.reference,
      captureId: captured.captureReference ?? '',
      grossMinor: captured.gross.amountMinor,
      feeMinor,
      netMinor,
      currency: trade.currency,
    });
    this.tellEntries(trade, captureEntries);

    if (this.payoutMode === 'immediate') await this.payout(trade);
  }

  /**
   * The processor said the buyer has not approved yet.
   *
   * The trade goes back on the pile with the link in it, unchanged in every other respect: still
   * funded, still on the books as somebody's claim, and still one click from a capture. Trying
   * again is the whole retry story, so the operator pressing the same card later is safe.
   */
  private awaitBuyer(trade: TradeRecord, approvalUrl: string | null): void {
    trade.held = true;
    trade.approvalUrl = approvalUrl;
    if (!trade.vetoRules.includes(AWAITING_APPROVAL_RULE)) {
      trade.vetoRules.push(AWAITING_APPROVAL_RULE);
      trade.vetoReasons.push(`order ${trade.orderId} is still open on the processor's site`);
    }
    trade.updatedAt = this.deps.now();
    this.say(trade, 'human.veto', {
      pending: true,
      rules: trade.vetoRules.join(','),
      reasons: trade.vetoReasons.join(' | '),
      grossMinor: trade.grossMinor,
      approvalUrl: approvalUrl ?? '',
    });
  }

  /**
   * Run the payout batch. Returns the trades it moved, so a caller can report on the batch
   * rather than re-deriving it.
   */
  async settlePayouts(): Promise<TradeRecord[]> {
    const queued = this.awaitingPayout;
    for (const trade of queued) await this.payout(trade);
    return queued;
  }

  /**
   * Pay the seller and take the fee, as one movement.
   *
   * Both lines leave escrow together, which is what keeps a refund honest: while a trade is
   * only captured the whole gross is still there to give back, and once it is paid out none of
   * it is - so the refund has to come from the platform's own cleared cash.
   */
  private async payout(trade: TradeRecord): Promise<void> {
    if (trade.phase !== 'captured') return;
    const payoutId = derivedId('pay', trade.id).slice(4, 20).toUpperCase();
    this.say(trade, 'payout.created', { payoutId, recipient: trade.seller, amountMinor: trade.netMinor, currency: trade.currency });

    let record = null;
    if (trade.netMinor > 0) {
      try {
        record = await this.deps.gateway.payout(trade.seller, { amountMinor: trade.netMinor, currency: trade.currency }, `Crier settlement ${trade.id}`);
      } catch (error) {
        trade.failure = messageOf(error);
        this.step(trade, 'failed', `payout ${payoutId} refused: ${trade.failure}`);
        this.say(trade, 'order.failed', { stage: 'payout', payoutId, error: trade.failure });
        return;
      }
      trade.payoutReference = record.reference;
    }

    const before = this.deps.ledger.size;
    this.deps.ledger.transaction(() => {
      if (record && trade.netMinor > 0) {
        recordPayout(this.deps.ledger, {
          ts: this.deps.now(),
          seller: trade.seller,
          netMinor: trade.netMinor,
          tradeId: trade.id,
          payoutId: record.reference,
          currency: trade.currency,
        });
      }
      if (trade.feeMinor > 0) {
        recordFeeSweep(this.deps.ledger, { ts: this.deps.now(), feeMinor: trade.feeMinor, tradeId: trade.id, currency: trade.currency });
      }
    });
    const payoutEntries = this.deps.ledger.listEntries().slice(before);
    trade.entries.push(...payoutEntries);

    this.step(
      trade,
      'paid_out',
      record && trade.netMinor > 0
        ? `paid ${trade.seller} via ${record.reference}, the fee swept to the settlement bank`
        : `the fee swept to the settlement bank - nothing left to pay the seller`,
    );
    if (record) {
      this.say(trade, 'payout.paid', { payoutId: record.reference, recipient: trade.seller, amountMinor: record.amount.amountMinor, status: record.status });
    }
    this.tellEntries(trade, payoutEntries);
  }

  /**
   * Hand money back. Before the seller has been paid the refund leaves escrow; after it, the
   * platform advances it from cleared cash and books the shortfall as its own loss - which is
   * exactly why the settlement bank has an opening float and a floor.
   */
  async refund(tradeId: string, amountMinor: number, reason: string): Promise<TradeRecord> {
    const trade = this.mustGet(tradeId);
    if (trade.phase !== 'captured' && trade.phase !== 'paid_out') {
      throw new SettlementError(`trade ${tradeId} is ${trade.phase} - there is no capture to refund`, tradeId);
    }
    if (!trade.orderId) throw new SettlementError(`trade ${tradeId} has no order to refund`, tradeId);
    const remaining = trade.grossMinor - trade.refundedMinor;
    if (amountMinor <= 0 || amountMinor > remaining) {
      throw new SettlementError(`refund of ${amountMinor} is outside the ${remaining} still refundable on trade ${tradeId}`, tradeId);
    }
    const paidOut = trade.phase === 'paid_out';
    const source = paidOut ? 'settlement_bank' : 'escrow';

    // The gateway is asked first, because that is the irreversible step; if our own books then
    // refuse the entry the trade is left failed-and-honest rather than silently un-reconciled.
    const record = await this.deps.gateway.refund(trade.orderId, { amountMinor, currency: trade.currency }, reason);
    trade.refundReferences.push(record.reference);

    try {
      const result = recordRefund(this.deps.ledger, {
        ts: this.deps.now(),
        buyer: trade.buyer,
        seller: trade.seller,
        refundMinor: amountMinor,
        tradeId: trade.id,
        refundId: record.reference,
        currency: trade.currency,
        feeReversalMinor: Math.min(trade.feeMinor, amountMinor),
        source,
      });
      trade.entries.push(result.clawbackEntry, result.releaseEntry);
      trade.refundedMinor += amountMinor;
      if (result.absorbedMinor > 0) {
        this.say(trade, 'ledger.entry', {
          entryId: result.clawbackEntry.id,
          code: result.clawbackEntry.code,
          account: ACCOUNT.chargebackLoss,
          amountMinor: result.absorbedMinor,
          currency: trade.currency,
          absorbed: true,
        });
      }
    } catch (error) {
      if (error instanceof LedgerError) {
        trade.failure = messageOf(error);
        this.say(trade, 'order.failed', { stage: 'refund', refundId: record.reference, error: trade.failure });
        throw new SettlementError(`refund of ${amountMinor} on trade ${tradeId} could not be funded: ${trade.failure}`, tradeId);
      }
      throw error;
    }

    const at = this.deps.now();
    if (trade.refundedMinor === trade.grossMinor) this.step(trade, 'refunded', `refund sent to ${trade.buyer}: ${reason}`);
    else {
      trade.phase = paidOut ? 'paid_out' : 'captured';
      trade.updatedAt = at;
      trade.steps.push({ phase: trade.phase, at, note: `part-refund sent to ${trade.buyer}: ${reason}` });
    }
    this.say(trade, 'payment.refunded', {
      refundId: record.reference,
      amountMinor,
      currency: trade.currency,
      reason,
      source,
      totalRefundedMinor: trade.refundedMinor,
    });
    return trade;
  }

  /**
   * Move the processor's asynchronous events onto the chain. Only ever called with events the
   * gateway itself vouched for, which is what `webhook.received` means on the tape.
   */
  ingest(events: readonly GatewayEvent[]): void {
    for (const event of events) {
      const trade = this.order
        .map((id) => this.mustGet(id))
        .find((candidate) => candidate.orderId === event.resourceId || candidate.captureReference === event.resourceId);
      append(
        this.deps.chain,
        this.deps.session,
        this.deps.exchange,
        'webhook.received',
        { eventId: event.id, eventType: event.eventType, resourceId: event.resourceId, tradeId: trade?.id ?? '', at: event.at },
        this.deps.now(),
      );
    }
  }

  /** Put a non-trade message (session open, a book state) on the chain. */
  announce(type: MessageType, payload: Record<string, unknown>, actor: Identity = this.deps.exchange): SealedMessage {
    return append(this.deps.chain, this.deps.session, actor, type, payload, this.deps.now());
  }

  /** Reference price guard: the fee the platform would take on this gross, for the UI. */
  feeOn(grossMinor: number): number {
    return feeFor(grossMinor, this.feeSchedule);
  }

  private tellEntries(trade: TradeRecord, entries: readonly LedgerEntry[]): void {
    for (const entry of entries) {
      const line = entry.postings[0];
      this.say(trade, 'ledger.entry', {
        entryId: entry.id,
        code: entry.code,
        account: line?.account ?? '',
        amountMinor: Math.max(line?.debit ?? 0, line?.credit ?? 0),
        currency: entry.currency,
        memo: entry.memo,
      });
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof GatewayError || error instanceof LedgerError || error instanceof SettlementError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
