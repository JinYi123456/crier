import { describe, expect, it } from 'vitest';
import { SimGateway } from '../src/gateway/sim';
import { GatewayError } from '../src/gateway/types';

const USD = (minor: number) => ({ amountMinor: minor, currency: 'USD' });

function order(tradeId: string, amountMinor = 120_00) {
  return {
    tradeId,
    amountMinor,
    currency: 'USD',
    buyer: 'buyer-kestrel',
    seller: 'seller-onyx',
    description: '2 x ceramic mug',
    invoiceNumber: `INV-${tradeId}`,
  };
}

describe('sim gateway contract', () => {
  it('walks created -> approved -> captured and records the capture reference', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-a'));
    expect(created.status).toBe('created');
    expect(created.reference.startsWith('SIM-')).toBe(true);

    const approved = await gateway.approveOrder(created.reference);
    expect(approved.status).toBe('approved');
    expect(approved.approvalUrl).toBeUndefined();

    const captured = await gateway.captureOrder(approved.reference);
    expect(captured.status).toBe('captured');
    expect(captured.captureReference?.startsWith('SIMCAP-')).toBe(true);
    expect(captured.capturedAt).toBeTypeOf('number');
  });

  it('will not capture something nobody approved', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-b'));
    await expect(gateway.captureOrder(created.reference)).rejects.toThrow(GatewayError);
  });

  it('hands the same order back when the same trade id is retried', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const first = await gateway.createOrder(order('trade-c'));
    await gateway.approveOrder(first.reference);
    const retry = await gateway.createOrder(order('trade-c'));
    expect(retry.reference).toBe(first.reference);
    expect(retry.status).toBe('approved');
    const again = await gateway.captureOrder(first.reference);
    const again2 = await gateway.captureOrder(first.reference);
    expect(again2.captureReference).toBe(again.captureReference);
  });

  it('declines the same trade every time, because a decline is derived not rolled', async () => {
    const a = new SimGateway({ declineBps: 5_000 });
    const b = new SimGateway({ declineBps: 5_000 });
    const o1 = await a.createOrder(order('trade-doomed'));
    const o2 = await b.createOrder(order('trade-doomed'));
    const r1 = await a.approveOrder(o1.reference);
    const r2 = await b.approveOrder(o2.reference);
    expect(r1.status).toBe(r2.status);
    if (r1.status === 'declined') expect(r1.declinedReason).toBe('payer_rejected_funding_source');
  });

  it('never declines when the dial is at zero, and always waits for review above the threshold', async () => {
    const cheap = new SimGateway({ declineBps: 0, reviewAboveMinor: 500_00 });
    const small = await cheap.createOrder(order('trade-small', 100_00));
    expect(small.approvalUrl).toBeUndefined();
    const big = await cheap.createOrder(order('trade-big', 900_00));
    expect(big.approvalUrl).toBeTypeOf('string');
    const approved = await cheap.approveOrder(big.reference);
    expect(approved.status).toBe('approved');
    expect(await cheap.listWaiting()).toHaveLength(0);

    const waiting = new SimGateway({ declineBps: 0, reviewAboveMinor: 1 });
    await waiting.createOrder(order('trade-waiting', 100_00));
    expect(await waiting.listWaiting()).toHaveLength(1);
  });

  it('refunds in parts against what is left, and calls the order refunded when the last of it goes', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-refund', 100_00));
    await gateway.approveOrder(created.reference);
    await gateway.captureOrder(created.reference);

    const partial = await gateway.refund(created.reference, USD(40_00), 'damaged on arrival');
    expect(partial.status).toBe('completed');
    expect(gateway.statusOf(created.reference)).toBe('captured');

    await expect(gateway.refund(created.reference, USD(70_00), 'too much')).rejects.toThrow(/outside the 6000 still refundable/);

    const rest = await gateway.refund(created.reference, USD(60_00), 'buyer changed mind');
    expect(rest.reference.startsWith('SIMREF-')).toBe(true);
    expect(rest.reference).not.toBe(partial.reference);
    expect(gateway.statusOf(created.reference)).toBe('refunded');
    await expect(gateway.refund(created.reference, USD(1), 'nothing left')).rejects.toThrow(/outside the 0 still refundable/);
  });

  it('refuses to refund an order that was never captured', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-uncaptured', 100_00));
    await expect(gateway.refund(created.reference, USD(50_00), 'premature')).rejects.toThrow(/only a captured order/);
  });

  it('voids an uncaught order but never a captured one', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-void'));
    const voided = await gateway.voidOrder(created.reference, 'human veto');
    expect(voided.status).toBe('voided');

    const other = await gateway.createOrder(order('trade-captured'));
    await gateway.approveOrder(other.reference);
    await gateway.captureOrder(other.reference);
    await expect(gateway.voidOrder(other.reference, 'too late')).rejects.toThrow(/refund it, do not void it/);
  });

  it('pays sellers out and records the batch note', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const payout = await gateway.payout('seller-onyx', USD(112_500), 'Crier settlement');
    expect(payout.status).toBe('paid');
    expect(payout.recipient).toBe('seller-onyx');
    expect(payout.reference.startsWith('SIMPAYOUT-')).toBe(true);
  });

  it('emits events in order and drains them once, like a webhook queue', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-events'));
    await gateway.approveOrder(created.reference);
    await gateway.captureOrder(created.reference);
    const events = gateway.drainEvents().map((event) => event.eventType);
    expect(events).toEqual(['CHECKOUT.ORDER.APPROVED.PENDING', 'CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED']);
    expect(gateway.drainEvents()).toEqual([]);
  });

  it('refuses a webhook that does not describe an order it issued', async () => {
    const gateway = new SimGateway({ declineBps: 0 });
    const created = await gateway.createOrder(order('trade-hook'));
    await gateway.approveOrder(created.reference);
    await gateway.captureOrder(created.reference);
    const events = gateway.drainEvents();
    const event = events[events.length - 1];

    const ok = await gateway.verifyWebhook({ 'paypal-auth-algo': 'sim' }, JSON.stringify({ event }));
    expect(ok?.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');

    const forged = { ...(event as object), resourceId: 'SIMCAP-SOMETHING-ELSE' };
    expect(await gateway.verifyWebhook({ 'paypal-auth-algo': 'sim' }, JSON.stringify({ event: forged }))).toBeNull();
    expect(await gateway.verifyWebhook({ 'paypal-auth-algo': 'sim' }, 'not json')).toBeNull();
    expect(await gateway.verifyWebhook({ 'paypal-auth-algo': 'sha256-with-rsa' }, JSON.stringify({ event }))).toBeNull();
  });

  it('rejects an order for nothing', async () => {
    const gateway = new SimGateway();
    await expect(gateway.createOrder(order('trade-zero', 0))).rejects.toThrow(/positive amount/);
  });
});
