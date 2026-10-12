import { derivedId } from '../core/canonical';
import { fromDecimalString, isCurrencyCode, toDecimalString, type CurrencyCode } from '../core/money';
import { SimGateway } from './sim';
import {
  AwaitingApprovalError,
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
 * The real processor - PayPal's Orders, Payments and Payouts REST APIs.
 *
 * A PayPal order is not a payment. Creating one only reserves an intent; the buyer then approves
 * it on PayPal's own site, and only after that can the platform capture it. That shape is the
 * whole reason this adapter exists: the floor has to be able to say "this settlement is waiting
 * on a person" and mean it in both directions, because our veto layer holds a trade and PayPal
 * holds the money behind it. Where the local sim pretends a buyer clicked, this one reports the
 * truth and lets the operator watch the queue.
 *
 * Money path: every capture lands in the platform's own PayPal account, and sellers are paid out
 * of it through the Payouts API. That is what a Platform-type app is permitted to do, and it keeps
 * the books honest - one collection in, one batch out, the fee taken between the two.
 */

export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
export const LIVE_API_BASE = 'https://api-m.paypal.com';

export interface PayPalOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Defaults to the sandbox host; only change it to point at the live one. */
  readonly apiBase?: string;
  /** The id of the webhook registered in the dashboard. No id means nothing can be verified. */
  readonly webhookId?: string;
  /** Public origin of this app, used for the URLs the buyer is sent back to. */
  readonly publicUrl?: string;
  /** Set only when the credentials are live rather than sandbox. */
  readonly live?: boolean;
  readonly payoutBatchNote?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface PayPalAmount {
  readonly currency_code?: string;
  readonly value?: string;
}

interface PayPalLink {
  readonly rel: string;
  readonly href: string;
}

interface PayPalPayment {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: PayPalAmount;
  readonly status_details?: { readonly reason?: string; readonly denial_reason?: string };
}

interface PayPalPurchaseUnit {
  readonly reference_id?: string;
  readonly invoice_id?: string;
  readonly custom_id?: string;
  readonly amount?: PayPalAmount;
  readonly payments?: {
    readonly captures?: readonly PayPalPayment[];
    readonly authorizations?: readonly PayPalPayment[];
    readonly refunds?: readonly PayPalPayment[];
  };
}

interface PayPalOrderBody {
  readonly id?: string;
  readonly status?: string;
  readonly intent?: string;
  readonly purchase_units?: readonly PayPalPurchaseUnit[];
  readonly links?: readonly PayPalLink[];
}

interface PayPalDetail {
  readonly field?: string;
  readonly value?: string;
  readonly description?: string;
  readonly issue?: string;
}

interface PayPalErrorBody {
  readonly name?: string;
  readonly message?: string;
  readonly issue?: string;
  readonly details?: readonly PayPalDetail[];
  readonly debug_id?: string;
}

interface TokenBody {
  readonly access_token?: string;
  readonly expires_in?: number;
}

interface PayoutBody {
  readonly batch_header?: {
    readonly payout_batch_id?: string;
    readonly batch_status?: { readonly status?: string };
  };
}

interface VerifyBody {
  readonly verification_status?: string;
}

/** PayPal's own order status mapped onto ours. */
function orderStatusOf(status: string | undefined, hasCapture: boolean): OrderStatus {
  if (hasCapture) return 'captured';
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'APPROVED':
      return 'approved';
    case 'VOIDED':
      return 'voided';
    default:
      return 'created';
  }
}

function moneyOf(amount: PayPalAmount | undefined, fallback: MoneyWire): MoneyWire {
  const currency = amount?.currency_code;
  const value = amount?.value;
  if (typeof currency !== 'string' || typeof value !== 'string' || !isCurrencyCode(currency)) return fallback;
  return { amountMinor: fromDecimalString(currency, value).minor, currency };
}

/** An alphanumeric id PayPal will accept in a `PayPal-Request-Id` header. */
function requestId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}${derivedId('req', ...parts).replace(/[^0-9a-zA-Z]/g, '').slice(0, 40).toUpperCase()}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export class PayPalGateway implements PaymentGateway {
  readonly mode: GatewayMode = 'sandbox';
  readonly webhookId: string | null;
  private readonly clientId: string;
  private readonly secret: string;
  private readonly base: string;
  private readonly publicUrl: string;
  private readonly payoutBatchNote: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  /** trade id -> order id, so a retried settlement reuses the order that already exists. */
  private readonly byTrade = new Map<string, string>();
  /** order id -> what we asked for it, because PayPal echoes back only what we put in it. */
  private readonly meta = new Map<string, CreateOrderInput>();
  /** order id -> capture id, which is what a refund actually addresses. */
  private readonly captures = new Map<string, string>();
  /** Orders this instance refused to capture because a human vetoed them. */
  private readonly lapsed = new Set<string>();

  constructor(options: PayPalOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new GatewayError(
        'sandbox mode needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET - without them the floor runs on the local sim',
        500,
      );
    }
    this.clientId = options.clientId;
    this.secret = options.clientSecret;
    this.base = (options.apiBase ?? (options.live ? LIVE_API_BASE : SANDBOX_API_BASE)).replace(/\/+$/, '');
    this.webhookId = options.webhookId && options.webhookId.length > 0 ? options.webhookId : null;
    // An empty public url is the documented default, not a mistake; anything that is not an
    // absolute http(s) address would be rejected by PayPal as a malformed return url, so we say so
    // here instead of three calls later.
    const configured = (options.publicUrl ?? '').trim();
    if (configured.length > 0 && !/^https?:\/\/[^/]+/i.test(configured)) {
      throw new GatewayError(`the app's public address must be a full http(s) url, got "${configured}"`, 500);
    }
    this.publicUrl = configured.length > 0 ? configured.replace(/\/+$/, '') : 'http://localhost:3000';
    this.payoutBatchNote = options.payoutBatchNote ?? 'Crier settlement';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.now ?? (() => Date.now());
  }

  /**
   * A bearer token is good for roughly three hours; PayPal rate-limits token calls, so one cached
   * token per instance is the polite way to run a floor.
   */
  private async accessToken(): Promise<string> {
    if (this.token !== null && this.tokenExpiresAt > this.clock() + 30_000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`, 'utf8').toString('base64');
    const response = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await response.text();
    const parsed = parseJson<TokenBody>(text);
    if (!response.ok || typeof parsed?.access_token !== 'string') {
      throw new GatewayError(
        `PayPal refused the credentials (${response.status}) - check that the app is a sandbox app and the pair is copied from the same one`,
        response.status,
        parsed ?? text,
      );
    }
    this.token = parsed.access_token;
    this.tokenExpiresAt = this.clock() + Math.max(60, parsed.expires_in ?? 3_600) * 1_000;
    return this.token;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = parseJson<T | PayPalErrorBody>(text);
    if (!response.ok) throw this.refusal(response.status, parsed, text, method, path);
    return parsed as T;
  }

  private refusal(status: number, parsed: unknown, raw: string, method: string, path: string): GatewayError {
    const body = (parsed ?? {}) as PayPalErrorBody;
    const detail = (body.details ?? [])
      .map((d) => `${typeof d.field === 'string' && d.field.length > 0 ? `${d.field}: ` : ''}${d.description ?? d.issue ?? ''}`)
      .filter((line) => line.length > 0)
      .join('; ');
    const message = [body.name, body.message].filter((line) => typeof line === 'string' && line.length > 0).join(' - ');
    const where = `${method} ${path}`;
    return new GatewayError(
      `PayPal refused ${where}: ${message.length > 0 ? message : status >= 500 ? 'the processor is unavailable' : 'the request was rejected'}${detail.length > 0 ? ` (${detail})` : ''}`,
      status,
      parsed ?? raw,
    );
  }

  private decimal(amount: MoneyWire): string {
    if (!isCurrencyCode(amount.currency)) {
      throw new GatewayError(`PayPal does not settle in ${amount.currency}`, 422, amount);
    }
    const currency = amount.currency as CurrencyCode;
    return toDecimalString({ currency, minor: amount.amountMinor });
  }

  private payerActionUrl(order: PayPalOrderBody): string | undefined {
    return order.links?.find((link) => link.rel === 'payer-action')?.href;
  }

  private firstPayment(order: PayPalOrderBody, kind: 'captures' | 'authorizations'): PayPalPayment | null {
    for (const unit of order.purchase_units ?? []) {
      const list = unit.payments?.[kind] ?? [];
      const found = list.find((payment) => typeof payment.id === 'string');
      if (found) return found;
    }
    return null;
  }

  /**
   * Read a PayPal order back into our shape. The metadata comes from what we put in, since PayPal
   * only carries a reference, an invoice id and a custom id.
   */
  private toPaymentOrder(order: PayPalOrderBody): PaymentOrder {
    const reference = order.id ?? '';
    const asked = this.meta.get(reference);
    const capture = this.firstPayment(order, 'captures');
    const authorization = this.firstPayment(order, 'authorizations');
    const gross = moneyOf(order.purchase_units?.[0]?.amount, asked ? { amountMinor: asked.amountMinor, currency: asked.currency } : { amountMinor: 0, currency: 'USD' });
    const status = orderStatusOf(order.status, capture !== null || authorization?.status === 'CAPTURED');
    const at = this.clock();
    if (capture?.id) this.captures.set(reference, capture.id);
    const approvalUrl = status === 'created' ? this.payerActionUrl(order) : undefined;
    return {
      reference,
      status,
      gross,
      createdAt: at,
      updatedAt: at,
      ...(approvalUrl ? { approvalUrl } : {}),
      ...(capture ? { capturedAt: at, captureReference: capture.id } : {}),
      ...(capture?.status === 'DECLINED'
        ? { declinedReason: capture.status_details?.reason ?? capture.status_details?.denial_reason ?? 'declined' }
        : {}),
      metadata: {
        tradeId: asked?.tradeId ?? order.purchase_units?.[0]?.reference_id ?? '',
        buyer: asked?.buyer ?? '',
        seller: asked?.seller ?? '',
        invoice: asked?.invoiceNumber ?? order.purchase_units?.[0]?.invoice_id ?? '',
      },
    };
  }

  async createOrder(input: CreateOrderInput): Promise<PaymentOrder> {
    if (input.amountMinor <= 0) throw new GatewayError('an order must be for a positive amount', 422, input);
    const existing = this.byTrade.get(input.tradeId);
    if (existing) {
      // Retrying a settlement must never create a second charge. If the order is old enough that
      // PayPal has dropped it, we re-read it and let the caller see the truth rather than a stale map.
      return this.fetchOrder(existing);
    }
    const body: PayPalOrderBody = await this.call(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.tradeId,
            invoice_id: input.invoiceNumber,
            custom_id: input.tradeId,
            description: clip(input.description, 127),
            amount: { currency_code: input.currency, value: this.decimal(input) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Crier',
              locale: 'en-US',
              user_action: 'PAY_NOW',
              return_url: `${this.publicUrl}/checkout/return?trade=${encodeURIComponent(input.tradeId)}`,
              cancel_url: `${this.publicUrl}/checkout/cancel?trade=${encodeURIComponent(input.tradeId)}`,
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
      { 'PayPal-Request-Id': requestId('CRIERORDER', input.tradeId) },
    );
    const reference = body.id;
    if (typeof reference !== 'string' || reference.length === 0) {
      throw new GatewayError('PayPal answered an order create without an order id', 502, body);
    }
    this.byTrade.set(input.tradeId, reference);
    this.meta.set(reference, input);
    return this.toPaymentOrder({ ...body, id: reference });
  }

  private async rawOrder(reference: string): Promise<PayPalOrderBody> {
    const body = await this.call<PayPalOrderBody>('GET', `/v2/checkout/orders/${encodeURIComponent(reference)}`);
    return { ...body, id: reference };
  }

  private async fetchOrder(reference: string): Promise<PaymentOrder> {
    return this.toPaymentOrder(await this.rawOrder(reference));
  }

  /**
   * The buyer's move, not ours. Approving here means "go and ask PayPal whether the buyer has
   * approved yet" - and when they have not, that is a state the floor needs to see, not a fault.
   */
  async approveOrder(reference: string): Promise<PaymentOrder> {
    if (this.lapsed.has(reference)) throw new GatewayError(`order ${reference} was voided by a veto and cannot come back`, 422);
    const order = await this.fetchOrder(reference);
    if (order.status === 'created') {
      throw new AwaitingApprovalError(reference, order.approvalUrl ?? null);
    }
    return order;
  }

  async captureOrder(reference: string): Promise<PaymentOrder> {
    if (this.lapsed.has(reference)) throw new GatewayError(`order ${reference} was voided by a veto and cannot come back`, 422);
    const current = await this.fetchOrder(reference);
    if (current.status === 'captured') return current;
    if (current.status !== 'approved') {
      throw new GatewayError(`order ${reference} must be approved before it can be captured (it is ${current.status})`, 422);
    }
    const body = await this.call<PayPalOrderBody>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(reference)}/capture`,
      {},
      { 'PayPal-Request-Id': requestId('CRIERCAPTURE', reference) },
    );
    const order = this.toPaymentOrder({ ...body, id: reference });
    return order;
  }

  /**
   * Refuse to take the money.
   *
   * PayPal's Orders API has no cancel endpoint: an order the buyer never approved simply is not
   * capturable, and an approved one can only be voided once it has been authorized. So this does
   * the two things that are actually available - void the authorization if there is one, and
   * otherwise mark the order lapsed here and refuse to capture it, which is the only guarantee
   * anybody can give at this layer.
   */
  async voidOrder(reference: string, reason: string): Promise<PaymentOrder> {
    const raw = await this.rawOrder(reference);
    const order = this.toPaymentOrder(raw);
    const capture = this.firstPayment(raw, 'captures');
    if (capture?.id && capture.status !== 'VOIDED') {
      throw new GatewayError(`order ${reference} is captured - refund it, do not void it`, 422);
    }
    const authorization = this.firstPayment(raw, 'authorizations');
    if (authorization?.id && authorization.status === 'CREATED') {
      await this.call('POST', `/v3/payments/authorizations/${encodeURIComponent(authorization.id)}/void`, {
        reason,
      });
    }
    this.lapsed.add(reference);
    const at = this.clock();
    return { ...order, status: 'voided', updatedAt: at, declinedReason: reason };
  }

  async refund(reference: string, amount: MoneyWire, reason: string): Promise<RefundRecord> {
    let captureId = this.captures.get(reference) ?? null;
    if (captureId === null) {
      captureId = this.firstPayment(await this.rawOrder(reference), 'captures')?.id ?? null;
    }
    if (captureId === null) throw new GatewayError(`no capture found for order ${reference} - there is nothing to refund`, 422);
    const body = await this.call<{ id?: string; status?: string; amount?: PayPalAmount }>(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      { amount: { currency_code: amount.currency, value: this.decimal(amount) }, note_to_payer: clip(reason, 255) },
      { 'PayPal-Request-Id': requestId('CRIERREFUND', reference, amount.amountMinor, reason) },
    );
    if (typeof body.id !== 'string') throw new GatewayError('PayPal answered a refund without a refund id', 502, body);
    const status = body.status === 'COMPLETED' ? 'completed' : body.status === 'FAILED' || body.status === 'DENIED' ? 'failed' : 'pending';
    return {
      reference: body.id,
      orderReference: reference,
      status,
      amount: moneyOf(body.amount, amount),
      reason,
      at: this.clock(),
    };
  }

  /**
   * Pay a seller out of the platform's own balance.
   *
   * `recipient` has to be an email address or a PayPal account id - the roster is seeded with
   * sandbox buyers and sellers, which is why the seat specs carry an address rather than a handle.
   */
  async payout(recipient: string, amount: MoneyWire, note: string): Promise<PayoutRecord> {
    if (amount.amountMinor <= 0) throw new GatewayError('a payout must be positive', 422);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) && !/^[A-Z0-9]{13,18}$/.test(recipient)) {
      throw new GatewayError(`PayPal cannot pay ${recipient} - a recipient must be an email address or a PayPal account id`, 422);
    }
    const batchId = requestId('CRIERBATCH', recipient, note, amount.amountMinor);
    const body = await this.call<PayoutBody>('POST', '/v1/identity/payouts', {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: this.payoutBatchNote,
        email_message: `A settlement from the floor has cleared to you: ${note}.`,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { currency_code: amount.currency, value: this.decimal(amount) },
          receiver: recipient,
          note: clip(note, 255),
          sender_item_id: batchId,
        },
      ],
    });
    const batch = body.batch_header?.payout_batch_id;
    if (typeof batch !== 'string') throw new GatewayError('PayPal answered a payout without a batch id', 502, body);
    const status = body.batch_header?.batch_status?.status;
    return {
      reference: batch,
      status: status === 'SUCCESS' ? 'paid' : status === 'FAILED' || status === 'CANCELLED' ? 'failed' : 'created',
      amount,
      recipient,
      note,
      at: this.clock(),
    };
  }

  /**
   * The live queue. PayPal has no endpoint that lists a merchant's open orders, so this reads back
   * every order this instance created and reports the ones still waiting on their buyer - which is
   * the same card the veto queue shows, because they are the same thing to a settlement run.
   */
  async listWaiting(): Promise<PaymentOrder[]> {
    const references = [...this.meta.keys()];
    const out: PaymentOrder[] = [];
    for (const reference of references) {
      const order = await this.fetchOrder(reference);
      if (order.status === 'created' && order.approvalUrl !== undefined) out.push(order);
    }
    return out;
  }

  /**
   * PayPal signs webhooks with a certificate chain rather than a shared secret, so verification is
   * a call back to PayPal: hand over the raw body and the five transmission headers, and only
   * accept the event if the answer is SUCCESS. Without a registered webhook id nothing is trusted.
   */
  async verifyWebhook(headers: Readonly<Record<string, string>>, rawBody: string): Promise<GatewayEvent | null> {
    if (this.webhookId === null) return null;
    const transmissionId = headers['paypal-transmission-id'];
    const authAlgo = headers['paypal-auth-algo'];
    const certUrl = headers['paypal-cert-url'];
    const transmissionTime = headers['paypal-transmission-time'];
    const sigma = headers['paypal-transmission-sigma'];
    if (!transmissionId || !authAlgo || !certUrl || !transmissionTime || !sigma) return null;
    if (!certUrl.startsWith('https://') || !certUrl.includes('.paypal.com')) return null;

    let event: { id?: string; event_type?: string; create_time?: string; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return null;
    }
    if (typeof event.id !== 'string' || typeof event.event_type !== 'string') return null;

    const body = await this.call<VerifyBody>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        webhook_id: this.webhookId,
        webhook_event: JSON.parse(rawBody) as unknown,
      },
      { 'paypal-auth-verification-type': 'RE:verify-webhook-signature' },
    );
    if (body.verification_status !== 'SUCCESS') return null;

    const resource = event.resource ?? {};
    const related = (resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids;
    const resourceId = typeof related?.order_id === 'string' ? related.order_id : typeof resource.id === 'string' ? resource.id : '';
    return {
      id: event.id,
      eventType: event.event_type,
      at: typeof event.create_time === 'string' ? Date.parse(event.create_time) : this.clock(),
      resourceId,
      payload: resource,
    };
  }

  snapshot(): { orders: PaymentOrder[] } {
    return { orders: [...this.meta.keys()].map((reference) => this.toPaymentOrder({ id: reference, status: 'CREATED' })) };
  }
}

function parseJson<T>(text: string): T | null {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Pick a gateway from the environment. The rule is that nothing here can fail an app boot: a
 * missing pair of credentials is not an error, it is the documented default, and the floor runs on
 * the local processor exactly as well.
 */
export function gatewayFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): PaymentGateway {
  const mode = (env.GATEWAY ?? 'sim').trim().toLowerCase();
  if (mode !== 'sandbox') {
    return new SimGateway({ declineBps: clampBps(Number(env.SIM_DECLINE_BPS)), reviewAboveMinor: 2_500_00 });
  }
  return new PayPalGateway({
    clientId: env.PAYPAL_CLIENT_ID ?? '',
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? '',
    apiBase: env.PAYPAL_API_BASE,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    publicUrl: env.PAYPAL_WEBHOOK_URL ?? env.PUBLIC_APP_URL,
    live: (env.PAYPAL_LIVE ?? 'false').trim() === 'true',
    payoutBatchNote: env.PAYPAL_PAYOUT_BATCH_NOTE,
  });
}

function clampBps(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, Math.round(value))) : 60;
}
