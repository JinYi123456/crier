import { derivedId, sha256Hex } from '../core/canonical';
import {
  GatewayError,
  type CreateOrderInput,
  type GatewayEvent,
  type GatewayMode,
  type MoneyWire,
  type OrderStatus,
  type PaymentGateway,
  type PaymentOrder,
  type PayoutRecord,
  type RefundRecord,
} from './types';

/**
 * A local stand-in for the processor.
 *
 * It exists so the whole floor - negotiation, matching, escrow, payout, refund, webhook - can
 * be run, filmed and tested without anyone holding credentials. It is deliberately as awkward
 * as the real thing: some orders need a human to approve them, a fixed slice of them are
 * declined on their own trade id, and captures arrive asynchronously as events. Nothing is
 * random: an order's fate is a hash of its trade id, so the same run declines the same deal.
 */

export interface SimOptions {
  /** 0-1000 basis points of orders that come back declined, keyed off the trade id. */
  readonly declineBps?: number;
  /** Orders above this amount always wait for a human - the veto layer's threshold. */
  readonly reviewAboveMinor?: number;
  readonly now?: () => number;
}

export class SimGateway implements PaymentGateway {
  readonly mode: GatewayMode = 'sim';
  private readonly orders = new Map<string, PaymentOrder>();
  private readonly byTrade = new Map<string, string>();
  private readonly refunds: RefundRecord[] = [];
  private readonly payouts: PayoutRecord[] = [];
  /** Every reference this instance minted - orders, captures, refunds, payouts. */
  private readonly issued = new Set<string>();
  private readonly events: GatewayEvent[] = [];
  private readonly declineBps: number;
  private readonly reviewAboveMinor: number;
  private readonly clock: () => number;

  constructor(options: SimOptions = {}) {
    this.declineBps = Math.max(0, Math.min(10_000, options.declineBps ?? 60));
    this.reviewAboveMinor = options.reviewAboveMinor ?? 250_000;
    this.clock = options.now ?? (() => Date.now());
  }

  private pushEvent(eventType: string, resourceId: string, payload: Record<string, unknown>): void {
    this.events.push({
      id: derivedId('evt', eventType, resourceId, String(this.events.length)),
      eventType,
      at: this.clock(),
      resourceId,
      payload,
    });
  }

  private declined(tradeId: string): boolean {
    const digest = sha256Hex(`crier/sim/decline|${tradeId}`);
    const roll = parseInt(digest.slice(0, 4), 16) % 10_000;
    return roll < this.declineBps;
  }

  async createOrder(input: CreateOrderInput): Promise<PaymentOrder> {
    if (input.amountMinor <= 0) throw new GatewayError('an order must be for a positive amount', 422, input);
    const existing = this.byTrade.get(input.tradeId);
    if (existing) {
      // Idempotent by our own trade id, exactly as the real API is keyed by a custom id:
      // retrying a settlement returns the order that already exists instead of charging twice.
      const found = this.orders.get(existing);
      if (!found) throw new GatewayError(`order ${existing} is missing from the sim store`, 500);
      return found;
    }
    const reference = `SIM-${derivedId('ref', input.tradeId).slice(5, 21).toUpperCase()}`;
    const at = this.clock();
    const needsReview = input.amountMinor > this.reviewAboveMinor || this.declined(input.tradeId);
    const order: PaymentOrder = {
      reference,
      status: 'created',
      gross: { amountMinor: input.amountMinor, currency: input.currency },
      createdAt: at,
      updatedAt: at,
      metadata: { tradeId: input.tradeId, buyer: input.buyer, seller: input.seller, invoice: input.invoiceNumber },
      ...(needsReview ? { approvalUrl: `http://localhost/approve/${reference}` } : {}),
    };
    this.orders.set(reference, order);
    this.byTrade.set(input.tradeId, reference);
    this.issued.add(reference);
    this.pushEvent('CHECKOUT.ORDER.APPROVED.PENDING', reference, { amount: input.amountMinor, needs_review: needsReview });
    return order;
  }

  async approveOrder(reference: string): Promise<PaymentOrder> {
    const order = this.mustFind(reference);
    if (order.status !== 'created') throw new GatewayError(`order ${reference} is already ${order.status}`, 422);
    if (this.declined(order.metadata.tradeId)) {
      const declined: PaymentOrder = {
        ...order,
        status: 'declined',
        updatedAt: this.clock(),
        declinedReason: 'payer_rejected_funding_source',
      };
      this.orders.set(reference, declined);
      this.pushEvent('PAYMENT.CAPABILITY.DENIED', reference, { reason: declined.declinedReason });
      return declined;
    }
    const approved: PaymentOrder = { ...order, status: 'approved', updatedAt: this.clock(), approvalUrl: undefined };
    this.orders.set(reference, approved);
    this.pushEvent('CHECKOUT.ORDER.APPROVED', reference, { amount: approved.gross.amountMinor });
    return approved;
  }

  async captureOrder(reference: string): Promise<PaymentOrder> {
    const order = this.mustFind(reference);
    if (order.status === 'captured') return order;
    if (order.status !== 'approved') throw new GatewayError(`order ${reference} must be approved before it can be captured (it is ${order.status})`, 422);
    const at = this.clock();
    const captureReference = `SIMCAP-${derivedId('cap', reference).slice(6, 20).toUpperCase()}`;
    const captured: PaymentOrder = { ...order, status: 'captured', updatedAt: at, capturedAt: at, captureReference };
    this.orders.set(reference, captured);
    this.issued.add(captureReference);
    this.pushEvent('PAYMENT.CAPTURE.COMPLETED', captureReference, {
      order_id: reference,
      amount: captured.gross.amountMinor,
      currency: captured.gross.currency,
    });
    return captured;
  }

  async voidOrder(reference: string, reason: string): Promise<PaymentOrder> {
    const order = this.mustFind(reference);
    if (order.status === 'captured') throw new GatewayError(`order ${reference} is captured - refund it, do not void it`, 422);
    if (order.status === 'refunded') throw new GatewayError(`order ${reference} is already closed out`, 422);
    const voided: PaymentOrder = { ...order, status: 'voided', updatedAt: this.clock(), declinedReason: reason };
    this.orders.set(reference, voided);
    this.pushEvent('CHECKOUT.ORDER.VOIDED', reference, { reason });
    return voided;
  }

  async refund(reference: string, amount: MoneyWire, reason: string): Promise<RefundRecord> {
    const order = this.mustFind(reference);
    if (order.status !== 'captured' && order.status !== 'refunded') {
      throw new GatewayError(`only a captured order can be refunded (order ${reference} is ${order.status})`, 422);
    }
    const already = order.refundedMinor ?? 0;
    const remaining = order.gross.amountMinor - already;
    if (amount.amountMinor <= 0 || amount.amountMinor > remaining) {
      throw new GatewayError(
        `refund of ${amount.amountMinor} is outside the ${remaining} still refundable on order ${reference}`,
        422,
      );
    }
    if (amount.currency !== order.gross.currency) {
      throw new GatewayError(`refund currency ${amount.currency} does not match the capture`, 422);
    }
    const refundedMinor = already + amount.amountMinor;
    const record: RefundRecord = {
      reference: `SIMREF-${derivedId('refund', reference, String(refundedMinor), reason).slice(7, 21).toUpperCase()}`,
      orderReference: reference,
      status: 'completed',
      amount,
      reason,
      at: this.clock(),
    };
    this.refunds.push(record);
    this.issued.add(record.reference);
    this.orders.set(reference, {
      ...order,
      status: refundedMinor === order.gross.amountMinor ? 'refunded' : order.status,
      refundedMinor,
      updatedAt: record.at,
    });
    this.pushEvent('PAYMENT.CAPTURE.REFUNDED', record.reference, {
      order_id: reference,
      amount: amount.amountMinor,
      refunded_total: refundedMinor,
    });
    return record;
  }

  async payout(recipient: string, amount: MoneyWire, note: string): Promise<PayoutRecord> {
    if (amount.amountMinor <= 0) throw new GatewayError('a payout must be positive', 422);
    const record: PayoutRecord = {
      reference: `SIMPAYOUT-${derivedId('payout', recipient, note).slice(8, 22).toUpperCase()}`,
      status: 'paid',
      amount,
      recipient,
      note,
      at: this.clock(),
    };
    this.payouts.push(record);
    this.issued.add(record.reference);
    this.pushEvent('PAYOUTS.ITEM.PAID', record.reference, { recipient, amount: amount.amountMinor });
    return record;
  }

  async listWaiting(): Promise<PaymentOrder[]> {
    return [...this.orders.values()].filter((order) => order.status === 'created' && order.approvalUrl !== undefined);
  }

  /**
   * The sim has no signature to check, so it accepts only bodies that reference something this
   * instance actually minted - an order, capture, refund or payout. A real deployment swaps in
   * the processor's certificate verifier.
   */
  async verifyWebhook(headers: Readonly<Record<string, string>>, rawBody: string): Promise<GatewayEvent | null> {
    if (headers['paypal-auth-algo'] !== 'sim') return null;
    let parsed: { event?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { event?: unknown };
    } catch {
      return null;
    }
    const event = parsed.event as GatewayEvent | undefined;
    if (!event || typeof event.resourceId !== 'string') return null;
    return this.issued.has(event.resourceId) ? event : null;
  }

  /** Drain the asynchronous event queue, as a webhook delivery loop would. */
  drainEvents(): GatewayEvent[] {
    const out = [...this.events];
    this.events.length = 0;
    return out;
  }

  snapshot(): { orders: PaymentOrder[]; refunds: RefundRecord[]; payouts: PayoutRecord[] } {
    return { orders: [...this.orders.values()], refunds: [...this.refunds], payouts: [...this.payouts] };
  }

  private mustFind(reference: string): PaymentOrder {
    const order = this.orders.get(reference);
    if (!order) throw new GatewayError(`unknown order ${reference}`, 404);
    return order;
  }

  statusOf(reference: string): OrderStatus | undefined {
    return this.orders.get(reference)?.status;
  }
}
