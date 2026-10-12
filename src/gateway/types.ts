/**
 * The payment boundary.
 *
 * Everything above this line is deterministic and testable; everything below it is a network
 * call to somebody else's ledger. Two implementations exist: a local one that behaves like
 * PayPal well enough to run the whole floor with no credentials, and a real one that talks to
 * the sandbox. The app cannot tell them apart except through `mode`.
 */

export type GatewayMode = 'sim' | 'sandbox';

export type OrderStatus = 'created' | 'approved' | 'captured' | 'voided' | 'declined' | 'refunded';
export type RefundStatus = 'pending' | 'completed' | 'failed';
export type PayoutStatus = 'created' | 'paid' | 'failed';

export interface MoneyWire {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface OrderMetadata {
  readonly tradeId: string;
  readonly buyer: string;
  readonly seller: string;
  readonly invoice: string;
  [key: string]: string;
}

export interface PaymentOrder {
  /** The processor's own id - what a screenshot of the payment will show. */
  readonly reference: string;
  readonly status: OrderStatus;
  readonly gross: MoneyWire;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Where a human approves this. Absent when the gateway approved it itself. */
  readonly approvalUrl?: string;
  readonly capturedAt?: number;
  readonly captureReference?: string;
  readonly declinedReason?: string;
  /** Minor units already refunded against this capture. Only present once a refund lands. */
  readonly refundedMinor?: number;
  /** Our trade id and parties, echoed straight back so a webhook cannot be pointed at the wrong deal. */
  readonly metadata: OrderMetadata;
}

export interface RefundRecord {
  readonly reference: string;
  readonly orderReference: string;
  readonly status: RefundStatus;
  readonly amount: MoneyWire;
  readonly reason: string;
  readonly at: number;
}

export interface PayoutRecord {
  readonly reference: string;
  readonly status: PayoutStatus;
  readonly amount: MoneyWire;
  readonly recipient: string;
  readonly note: string;
  readonly at: number;
}

export interface CreateOrderInput extends MoneyWire {
  readonly tradeId: string;
  readonly buyer: string;
  readonly seller: string;
  readonly description: string;
  readonly invoiceNumber: string;
}

export interface GatewayEvent {
  readonly id: string;
  readonly eventType: string;
  readonly at: number;
  readonly resourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PaymentGateway {
  readonly mode: GatewayMode;

  createOrder(input: CreateOrderInput): Promise<PaymentOrder>;
  /** Approve an order. In the sandbox a human does this in a browser; here the caller says so. */
  approveOrder(reference: string): Promise<PaymentOrder>;
  captureOrder(reference: string): Promise<PaymentOrder>;
  voidOrder(reference: string, reason: string): Promise<PaymentOrder>;
  refund(reference: string, amount: MoneyWire, reason: string): Promise<RefundRecord>;
  payout(recipient: string, amount: MoneyWire, note: string): Promise<PayoutRecord>;

  /** Pending approvals a human can act on. */
  listWaiting(): Promise<PaymentOrder[]>;

  /**
   * Verify an incoming webhook against the processor's signature. Returns the parsed event
   * when the signature checks out, or null - the caller must treat null as "refuse".
   */
  verifyWebhook(headers: Readonly<Record<string, string>>, rawBody: string): Promise<GatewayEvent | null>;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status = 502, detail: unknown = null) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
  }
}
