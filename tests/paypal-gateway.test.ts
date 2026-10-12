import { describe, expect, it } from 'vitest';
import { PayPalGateway, gatewayFromEnvironment, type PayPalOptions } from '../src/gateway/paypal';
import { AwaitingApprovalError, GatewayError, type CreateOrderInput } from '../src/gateway/types';

/**
 * A stand-in for PayPal's REST API.
 *
 * Every test here runs against this fake rather than the network: it answers the same routes with
 * the same shapes and records every call, so the tests can assert what the adapter actually asked
 * for and not only what it got back.
 */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

interface FakeState {
  /** Order id -> the status the processor reports for it. */
  orderStatus: Map<string, string>;
  /** Order id -> what the buyer was asked to pay, echoed straight back. */
  amounts: Map<string, { currency_code: string; value: string }>;
  /** Order id -> the capture the processor holds against it. */
  captures: Map<string, string>;
  /** Order id -> an uncaptured authorization. */
  authorizations: Map<string, string>;
  verificationStatus: string;
  createCount: number;
  tokenCount: number;
  captureCount: number;
}

const USD = (minor: number) => ({ amountMinor: minor, currency: 'USD' });

function input(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    tradeId: 'trade_0001',
    amountMinor: 120_00,
    currency: 'USD',
    buyer: 'buyer-kestrel',
    seller: 'seller-onyx',
    description: '10 x coffee-green at 1200 - a bulk order of green beans',
    invoiceNumber: 'CRIER-ABCD1234',
    ...overrides,
  };
}

function fakePaypal(): { fetch: typeof fetch; state: FakeState; calls: Call[] } {
  const state: FakeState = {
    orderStatus: new Map(),
    amounts: new Map(),
    captures: new Map(),
    authorizations: new Map(),
    verificationStatus: 'SUCCESS',
    createCount: 0,
    tokenCount: 0,
    captureCount: 0,
  };
  const calls: Call[] = [];

  const orderBody = (id: string) => {
    const status = state.orderStatus.get(id) ?? 'CREATED';
    const capture = state.captures.get(id);
    const authorization = state.authorizations.get(id);
    const links: { rel: string; href: string }[] = [];
    if (status === 'CREATED') links.push({ rel: 'payer-action', href: `https://sandbox.paypal.com/checkoutnow?token=${id}` });
    return {
      id,
      status,
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'trade_0001',
          invoice_id: 'CRIER-ABCD1234',
          amount: state.amounts.get(id) ?? { currency_code: 'USD', value: '120.00' },
          payments: {
            ...(capture ? { captures: [{ id: capture, status: 'COMPLETED', amount: state.amounts.get(id) }] } : {}),
            ...(authorization ? { authorizations: [{ id: authorization, status: 'CREATED' }] } : {}),
          },
        },
      ],
      links,
    };
  };

  const respond = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as unknown as Awaited<ReturnType<typeof fetch>>;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    const path = full.replace(/^https:\/\/api-m\.sandbox\.paypal\.com/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body, headers });

    if (path === '/v1/oauth2/token') {
      state.tokenCount += 1;
      if (!headers.authorization?.startsWith('Basic ')) return respond(401, { name: 'INVALID_CLIENT', message: 'Authentication failed' });
      return respond(200, { access_token: 'A21.token', expires_in: 32400, token_type: 'Bearer' });
    }

    if (path === '/v2/checkout/orders' && method === 'POST') {
      if (!headers.authorization?.startsWith('Bearer ')) return respond(401, { name: 'INVALID_TOKEN' });
      state.createCount += 1;
      const id = `ORD${state.createCount}`;
      const unit = (body as { purchase_units: { amount: { currency_code: string; value: string } }[] }).purchase_units[0] ?? {
        amount: { currency_code: 'USD', value: '0.00' },
      };
      state.amounts.set(id, { currency_code: unit.amount.currency_code, value: unit.amount.value });
      state.orderStatus.set(id, 'CREATED');
      return respond(201, orderBody(id));
    }

    const getOrder = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (getOrder && method === 'GET') {
      const id = getOrder[1] as string;
      if (!state.orderStatus.has(id)) return respond(404, { name: 'RESOURCE_NOT_FOUND', message: `Order not found` });
      return respond(200, orderBody(id));
    }

    const capture = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    if (capture && method === 'POST') {
      const id = capture[1] as string;
      if (!state.orderStatus.has(id)) return respond(404, { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' });
      if (state.orderStatus.get(id) !== 'APPROVED') {
        return respond(422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The order cannot be captured because it is not approved',
          details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved the order before the capture' }],
        });
      }
      state.captureCount += 1;
      state.captures.set(id, `CAP${state.captureCount}`);
      state.orderStatus.set(id, 'COMPLETED');
      return respond(201, orderBody(id));
    }

    const refund = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path);
    if (refund && method === 'POST') {
      return respond(201, {
        id: 'REF1',
        status: 'COMPLETED',
        amount: (body as { amount?: { currency_code: string; value: string } }).amount,
        capture_id: refund[1],
      });
    }

    const voidAuth = /^\/v3\/payments\/authorizations\/([^/]+)\/void$/.exec(path);
    if (voidAuth && method === 'POST') return respond(204, {});

    if (path === '/v1/identity/payouts' && method === 'POST') {
      const batch = (body as { sender_batch_header?: { sender_batch_id?: string } }).sender_batch_header;
      const receiver = (body as { items?: { receiver?: string }[] }).items?.[0]?.receiver;
      const status = receiver === 'broken@example.com' ? 'FAILED' : 'SUCCESS';
      return respond(200, { batch_header: { payout_batch_id: `BATCH-${batch?.sender_batch_id}`, batch_status: { status } } });
    }

    if (path === '/v1/notifications/verify-webhook-signature' && method === 'POST') {
      return respond(200, { verification_status: state.verificationStatus });
    }

    return respond(404, { name: 'RESOURCE_NOT_FOUND', message: `no route for ${method} ${path}` });
  }) as typeof fetch;

  return { fetch: fetchImpl, state, calls };
}

function gateway(options: Partial<PayPalOptions> = {}): { paypal: PayPalGateway; fake: ReturnType<typeof fakePaypal> } {
  const fake = fakePaypal();
  const paypal = new PayPalGateway({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicUrl: 'https://crier.example',
    fetchImpl: fake.fetch,
    now: () => 1_700_000_000_000,
    ...options,
  });
  return { paypal, fake };
}

/** Put the fake into the state a real buyer produces: they opened the page and approved. */
function buyerApproves(fake: ReturnType<typeof fakePaypal>, reference: string): void {
  fake.state.orderStatus.set(reference, 'APPROVED');
}

async function approveAndCapture(paypal: PayPalGateway, reference: string, fake: ReturnType<typeof fakePaypal>) {
  buyerApproves(fake, reference);
  await paypal.approveOrder(reference);
  return paypal.captureOrder(reference);
}

describe('paypal gateway', () => {
  it('refuses to be the gateway when there are no credentials', () => {
    expect(() => new PayPalGateway({ clientId: '', clientSecret: '', fetchImpl: fakePaypal().fetch })).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => new PayPalGateway({ clientId: 'a', clientSecret: '', fetchImpl: fakePaypal().fetch })).toThrow(GatewayError);
  });

  it('trades one token for the whole session and keeps it', async () => {
    const { paypal, fake } = gateway();
    const first = await paypal.createOrder(input({ tradeId: 'trade_a' }));
    const second = await paypal.createOrder(input({ tradeId: 'trade_b' }));
    expect(first.reference).toBe('ORD1');
    expect(second.reference).toBe('ORD2');
    expect(fake.state.tokenCount).toBe(1);
    const tokenCalls = fake.calls.filter((call) => call.path === '/v1/oauth2/token');
    expect(tokenCalls[0]?.body).toBeNull();
    expect(tokenCalls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fake.calls.every((call) => call.path === '/v1/oauth2/token' || call.headers.authorization === 'Bearer A21.token')).toBe(true);
  });

  it('creates an order and reads the answer back into our money and metadata', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    expect(created.status).toBe('created');
    expect(created.gross).toEqual({ amountMinor: 120_00, currency: 'USD' });
    expect(created.approvalUrl).toBe('https://sandbox.paypal.com/checkoutnow?token=ORD1');
    expect(created.metadata).toEqual({ tradeId: 'trade_0001', buyer: 'buyer-kestrel', seller: 'seller-onyx', invoice: 'CRIER-ABCD1234' });

    const call = fake.calls.find((entry) => entry.path === '/v2/checkout/orders');
    const body = call?.body as { intent: string; purchase_units: { amount: { value: string; currency_code: string }; description: string }[] };
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: 'USD', value: '120.00' });
    expect(body.purchase_units[0]?.description.length).toBeLessThanOrEqual(127);
    expect(call?.headers['PayPal-Request-Id']).toMatch(/^CRIERORDER/);
  });

  it('sends a zero-decimal currency the way the processor expects it', async () => {
    const { paypal, fake } = gateway();
    await paypal.createOrder(input({ currency: 'JPY', amountMinor: 1_200 }));
    const call = fake.calls.find((entry) => entry.path === '/v2/checkout/orders');
    expect((call?.body as { purchase_units: { amount: { value: string } }[] }).purchase_units[0]?.amount.value).toBe('1200');
  });

  it('refuses a currency the processor does not settle in', async () => {
    const { paypal } = gateway();
    await expect(paypal.createOrder(input({ currency: 'XYZ' }))).rejects.toThrow(/does not settle/);
  });

  it('retries a settlement without ever creating a second charge', async () => {
    const { paypal, fake } = gateway();
    const first = await paypal.createOrder(input());
    buyerApproves(fake, first.reference);
    const retry = await paypal.createOrder(input());
    expect(retry.reference).toBe(first.reference);
    expect(retry.status).toBe('approved');
    expect(fake.state.createCount).toBe(1);
  });

  it('reports an unapproved order as waiting on the buyer rather than as broken', async () => {
    const { paypal } = gateway();
    const created = await paypal.createOrder(input());
    const error = await paypal.approveOrder(created.reference).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AwaitingApprovalError);
    expect((error as AwaitingApprovalError).status).toBe(409);
    expect((error as AwaitingApprovalError).approvalUrl).toBe('https://sandbox.paypal.com/checkoutnow?token=ORD1');
    await expect(paypal.captureOrder(created.reference)).rejects.toThrow(/must be approved/);
  });

  it('captures once the buyer has actually approved, and never asks twice', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    buyerApproves(fake, created.reference);
    const approved = await paypal.approveOrder(created.reference);
    expect(approved.status).toBe('approved');
    expect(approved.approvalUrl).toBeUndefined();

    const captured = await paypal.captureOrder(approved.reference);
    expect(captured.status).toBe('captured');
    expect(captured.captureReference).toBe('CAP1');
    expect(captured.capturedAt).toBe(1_700_000_000_000);

    const again = await paypal.captureOrder(created.reference);
    expect(again.captureReference).toBe('CAP1');
    expect(fake.state.captureCount).toBe(1);
  });

  it('refunds the capture, because that is what the money was taken against', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    await approveAndCapture(paypal, created.reference, fake);
    const refund = await paypal.refund(created.reference, USD(40_00), 'damaged on arrival');
    expect(refund.reference).toBe('REF1');
    expect(refund.orderReference).toBe(created.reference);
    expect(refund.status).toBe('completed');
    expect(refund.amount).toEqual({ amountMinor: 40_00, currency: 'USD' });
    const call = fake.calls.find((entry) => entry.path === '/v2/payments/captures/CAP1/refund');
    expect(call?.headers['PayPal-Request-Id']).toMatch(/^CRIERREFUND/);
    expect(fake.calls.some((entry) => entry.path === '/v2/payments/captures/ORD1/refund')).toBe(false);
  });

  it('refuses to refund something nobody captured', async () => {
    const { paypal } = gateway();
    const created = await paypal.createOrder(input());
    await expect(paypal.refund(created.reference, USD(10_00), 'too early')).rejects.toThrow(/nothing to refund/);
  });

  it('voids an open order by making it uncapturable, and says so afterwards', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    const voided = await paypal.voidOrder(created.reference, 'human veto');
    expect(voided.status).toBe('voided');
    expect(voided.declinedReason).toBe('human veto');
    buyerApproves(fake, created.reference);
    await expect(paypal.captureOrder(created.reference)).rejects.toThrow(/was voided by a veto/);
    await expect(paypal.approveOrder(created.reference)).rejects.toThrow(/was voided by a veto/);
  });

  it('voids a real authorization when the processor has one to void', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    fake.state.authorizations.set(created.reference, 'AUTH1');
    await paypal.voidOrder(created.reference, 'operator refused');
    expect(fake.calls.some((call) => call.path === '/v3/payments/authorizations/AUTH1/void')).toBe(true);
  });

  it('will not void a captured order', async () => {
    const { paypal, fake } = gateway();
    const created = await paypal.createOrder(input());
    await approveAndCapture(paypal, created.reference, fake);
    await expect(paypal.voidOrder(created.reference, 'too late')).rejects.toThrow(/refund it, do not void it/);
  });

  it('pays a seller out and maps the batch answer', async () => {
    const { paypal } = gateway();
    const paid = await paypal.payout('seller-onyx@example.com', USD(112_500), 'Crier settlement trade_0001');
    expect(paid.status).toBe('paid');
    expect(paid.reference).toMatch(/^BATCH-CRIERBATCH/);
    const failed = await paypal.payout('broken@example.com', USD(1_00), 'another');
    expect(failed.status).toBe('failed');
  });

  it('refuses to send money to a handle when the processor needs an address', async () => {
    const { paypal, fake } = gateway();
    await expect(paypal.payout('seller-onyx', USD(100_00), 'note')).rejects.toThrow(/email address or a PayPal account id/);
    expect(fake.calls.filter((call) => call.path === '/v1/identity/payouts')).toHaveLength(0);
  });

  it('shows the live approval queue, refreshed from the processor', async () => {
    const { paypal, fake } = gateway();
    const waiting = await paypal.createOrder(input({ tradeId: 'trade_wait' }));
    const done = await paypal.createOrder(input({ tradeId: 'trade_done' }));
    await approveAndCapture(paypal, done.reference, fake);

    const queue = await paypal.listWaiting();
    expect(queue.map((order) => order.reference)).toEqual([waiting.reference]);
    expect(queue[0]?.approvalUrl).toContain('checkoutnow');

    await approveAndCapture(paypal, waiting.reference, fake);
    expect(await paypal.listWaiting()).toEqual([]);
  });

  it('trusts a webhook only when PayPal vouches for the signature', async () => {
    const headers = {
      'paypal-transmission-id': 'T-1',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/x/cert/DuXX',
      'paypal-transmission-time': '2026-10-13T14:00:00Z',
      'paypal-transmission-sigma': 'abc',
    };
    const raw = JSON.stringify({
      id: 'EV-1',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      create_time: '2026-10-13T14:00:01Z',
      resource: { id: 'ORD1', supplementary_data: { related_ids: { order_id: 'ORD1' } } },
    });

    const unconfigured = gateway();
    expect(await unconfigured.paypal.verifyWebhook(headers, raw)).toBeNull();
    expect(unconfigured.fake.calls.filter((call) => call.path === '/v1/notifications/verify-webhook-signature')).toHaveLength(0);

    const { paypal, fake } = gateway({ webhookId: 'WH-1' });
    const event = await paypal.verifyWebhook(headers, raw);
    expect(event?.eventType).toBe('CHECKOUT.ORDER.APPROVED');
    expect(event?.resourceId).toBe('ORD1');
    expect(event?.id).toBe('EV-1');
    const verify = fake.calls.find((call) => call.path === '/v1/notifications/verify-webhook-signature');
    expect(verify?.headers['paypal-auth-verification-type']).toBe('RE:verify-webhook-signature');
    expect((verify?.body as { webhook_id: string }).webhook_id).toBe('WH-1');

    fake.state.verificationStatus = 'FAILURE';
    expect(await paypal.verifyWebhook(headers, raw)).toBeNull();

    expect(await paypal.verifyWebhook({ ...headers, 'paypal-cert-url': 'https://evil.example/cert' }, raw)).toBeNull();
    expect(await paypal.verifyWebhook({ 'paypal-transmission-id': 'T-1' }, raw)).toBeNull();
    expect(await paypal.verifyWebhook(headers, 'not json')).toBeNull();
  });

  it('carries the processor refusal through into a message a person can act on', async () => {
    const { paypal } = gateway();
    await expect(paypal.captureOrder('NOPE')).rejects.toThrow(/RESOURCE_NOT_FOUND/);

    const unavailable = (async (url: string | URL | Request) => {
      const path = String(url).replace(/^https:\/\/api-m\.sandbox\.paypal\.com/, '');
      if (path === '/v1/oauth2/token') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'A21.token', expires_in: 32400 }) } as unknown as Awaited<ReturnType<typeof fetch>>;
      }
      return { ok: false, status: 500, text: async () => '' } as unknown as Awaited<ReturnType<typeof fetch>>;
    }) as typeof fetch;

    const offline = new PayPalGateway({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl: unavailable,
    });
    await expect(offline.createOrder(input())).rejects.toThrow(/the processor is unavailable/);
  });
});

describe('gateway selection', () => {
  it('stays on the local processor unless the app is told otherwise', () => {
    expect(gatewayFromEnvironment({}).mode).toBe('sim');
    expect(gatewayFromEnvironment({ GATEWAY: 'sim' }).mode).toBe('sim');
    expect(gatewayFromEnvironment({ GATEWAY: 'SANDBOX', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }).mode).toBe('sandbox');
    expect(() => gatewayFromEnvironment({ GATEWAY: 'sandbox' })).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it('keeps the local processor deterministic when the dial is nonsense', async () => {
    const defaultish = gatewayFromEnvironment({ SIM_DECLINE_BPS: 'not a number' });
    const created = await defaultish.createOrder(input());
    expect(created.reference.startsWith('SIM-')).toBe(true);
  });
});
