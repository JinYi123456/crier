import { describe, expect, it } from 'vitest';
import {
  FloorError,
  actOnFloorTrade,
  closeFloor,
  deliverEvent,
  floorSnapshot,
  openFloor,
  runFloor,
  stepFloor,
  suggestedSeed,
  tamperFloor,
  webhookGateway,
} from '../src/server/floor';
import type { GatewayEvent } from '../src/gateway/types';
import type { SessionSnapshot } from '../src/core/world';
import { computeSealHash, keyringFrom, verifyChain } from '../src/core/protocol';
import { identityFromPublicKeyHex } from '../src/core/keys';
import { GET } from '../src/app/api/floor/[id]/tape/route';

/**
 * The floor as a service.
 *
 * These tests hold the room the way a browser does - open it, ring the bell, read the snapshot, do
 * the human things to a trade, take the tape away and try to fake it, then hand the floor a webhook.
 * Nothing here reaches for credentials: the local processor plays its part, which is the point of
 * the room being watchable with nothing installed.
 */

async function floor(seed: string, options: { instruments?: string[]; maxTicks?: number } = {}) {
  const room = await openFloor({ seed, ...(options.instruments ? { instruments: options.instruments } : {}), maxTicks: options.maxTicks ?? 8 });
  return { id: room.session.session, room };
}

describe('the floor as a service', () => {
  it('opens the same seed and shape into the same room', async () => {
    const first = await floor('same-seed-room');
    const again = await openFloor({ seed: 'same-seed-room', maxTicks: 8 });
    expect(again.session.session).toBe(first.id);
    expect(again).toBe(first.room);
    expect(first.id).toMatch(/^crier_/);
    // The id fingerprints the whole shape of the recording, so a longer floor is a different room.
    const longer = await openFloor({ seed: 'same-seed-room', maxTicks: 9 });
    expect(longer.session.session).not.toBe(first.id);
  });

  it('refuses a seed too short to be a recording', async () => {
    await expect(openFloor({ seed: 'ab' })).rejects.toBeInstanceOf(FloorError);
  });

  it('rings the bell and leaves a tape that verifies', async () => {
    const { id } = await floor('bell-round', { instruments: ['coffee-green'] });
    const result = await stepFloor(id);
    expect(result.tick).toBe(1);
    const { snapshot } = floorSnapshot(id);
    expect(snapshot.messages.length).toBeGreaterThan(1);
    expect(snapshot.verification.ok).toBe(true);
  });

  it('hands over a recording that stands on its own', async () => {
    const { id } = await floor('take-the-tape', { instruments: ['coffee-green'], maxTicks: 3 });
    await runFloor(id);
    await closeFloor(id);

    const response = await GET(new Request(`http://localhost/api/floor/${id}/tape`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(`${id}.tape.json`);
    const recording = (await response.json()) as SessionSnapshot;

    // Checked with nothing but the file: the keyring is the public keys the tape carries itself, and
    // the trial balance is re-added from the postings rather than read off the summary it prints.
    const keyring = keyringFrom(recording.messages.map((message) => identityFromPublicKeyHex(message.actor, message.key)));
    expect(verifyChain(recording.messages, keyring).ok).toBe(true);
    const side = (pick: 'debit' | 'credit') =>
      recording.entries.reduce((total, entry) => total + entry.postings.reduce((sum, posting) => sum + posting[pick], 0), 0);
    expect(side('debit')).toBe(side('credit'));
    expect(recording.headHash).toBe(computeSealHash(recording.messages[recording.messages.length - 1]!));
  });

  it('answers an unknown room with a 404', () => {
    try {
      floorSnapshot('crier_nobody_here');
      throw new Error('expected the room to be missing');
    } catch (error) {
      expect(error).toBeInstanceOf(FloorError);
      expect((error as FloorError).status).toBe(404);
    }
  });

  it('trims the tape to what the caller has not seen, but never the books', async () => {
    const { id } = await floor('trimmed-tape', { instruments: ['ceramic-mug'] });
    await runFloor(id);
    const full = floorSnapshot(id);
    const last = full.sinceSeq;
    const tail = floorSnapshot(id, last);
    expect(full.snapshot.messages.length).toBeGreaterThan(1);
    expect(tail.snapshot.messages).toEqual([]);
    expect(tail.snapshot.trades).toEqual(full.snapshot.trades);
    expect(tail.snapshot.entries).toEqual(full.snapshot.entries);
    const middle = floorSnapshot(id, Math.floor(last / 2));
    expect(middle.snapshot.messages.length).toBeLessThan(full.snapshot.messages.length);
    expect(middle.snapshot.messages[0]!.seq).toBeGreaterThan(Math.floor(last / 2));
  });

  it('runs the floor to the bell and closes it', async () => {
    const { id } = await floor('run-to-close', { instruments: ['coffee-green'], maxTicks: 3 });
    const rounds = await runFloor(id);
    expect(rounds.length).toBeGreaterThan(0);
    const closed = await closeFloor(id);
    expect(closed.closed).toBe(true);
    expect(closed.messages).toBeGreaterThan(0);
    await expect(stepFloor(id)).rejects.toThrow(/closed/);
  });

  it('does the human things to a trade and refuses the ones with no reason', async () => {
    const { id } = await floor('human-actions', { instruments: ['saffron'], maxTicks: 8 });
    await runFloor(id);
    const { snapshot } = floorSnapshot(id);
    const held = snapshot.trades.find((trade) => trade.held);
    expect(held).toBeDefined();
    if (!held) return;

    await expect(actOnFloorTrade(id, { action: 'veto', tradeId: held.id })).rejects.toThrow(/has to say why/);

    const released = await actOnFloorTrade(id, { action: 'release', tradeId: held.id, note: 'checked the counterparty' });
    expect(released.held).toBe(false);
    expect(released.vetoNote ?? '').toBe('');
    expect(released.phase).not.toBe('matched');

    const refundable = snapshot.trades.find((trade) => trade.phase === 'paid_out' || trade.phase === 'captured');
    expect(refundable).toBeDefined();
    if (!refundable) return;
    const partial = await actOnFloorTrade(id, {
      action: 'partial_refund',
      tradeId: refundable.id,
      amountMinor: 100,
      note: 'one bag short',
    });
    expect(partial.refundedMinor).toBe(100);
    await expect(actOnFloorTrade(id, { action: 'partial_refund', tradeId: refundable.id, amountMinor: 0 })).rejects.toThrow(/positive amount/);

    const rest = await actOnFloorTrade(id, { action: 'refund', tradeId: refundable.id, note: 'buyer changed mind' });
    expect(rest.refundedMinor).toBe(rest.grossMinor);
    expect(rest.phase).toBe('refunded');
  });

  it('reports an edit to the tape at the message it happened and at every seal after it', async () => {
    const { id, room } = await floor('tamper-proof', { instruments: ['coffee-green'] });
    await runFloor(id);
    const messages = room.session.chain.messages;
    const target = messages.find((message) => message.type === 'ledger.entry') ?? messages[Math.floor(messages.length / 2)]!;
    const result = tamperFloor(id, target.seq, 'grossMinor');
    expect(result.total).toBe(messages.length);
    expect(result.findings.length).toBeGreaterThan(1);
    expect(result.findings[0]!.seq).toBe(target.seq);
    expect(result.findings.some((finding) => finding.code === 'body_hash_mismatch')).toBe(true);
    expect(result.findings.some((finding) => finding.code === 'chain_break')).toBe(true);
    expect(result.first.length).toBeLessThanOrEqual(4);
    // The demonstration copies the chain - the room's own tape is untouched and still verifies.
    expect(verifyChain(messages, room.session.keyring).ok).toBe(true);
  });

  it('refuses to demonstrate a tamper on a tape that does not already verify', async () => {
    const { id, room } = await floor('no-proof-on-broken', { instruments: ['coffee-green'] });
    await stepFloor(id);
    const messages = room.session.chain.messages;
    const first = messages[0]!;
    messages.splice(0, 1, { ...first, payload: { tampered: true } });
    expect(() => tamperFloor(id, first.seq)).toThrow(/does not verify/);
  });

  it('only lets a processor that minted the order talk about it', async () => {
    const { id } = await floor('webhook-door', { instruments: ['ceramic-mug'] });
    await runFloor(id);
    const { snapshot } = floorSnapshot(id);
    const trade = snapshot.trades.find((candidate) => candidate.orderId !== null);
    expect(trade).toBeDefined();
    if (!trade || trade.orderId === null) return;
    const orderId = trade.orderId;

    const gateway = webhookGateway(id);
    expect(gateway).not.toBeNull();
    const forged = await gateway!.verifyWebhook(
      { 'paypal-auth-algo': 'COUNTERFEIT' },
      JSON.stringify({ event: { id: 'evt_forged', eventType: 'checkout.order.approved', at: 0, resourceId: orderId, payload: {} } }),
    );
    expect(forged).toBeNull();

    const notMine = await gateway!.verifyWebhook(
      { 'paypal-auth-algo': 'sim' },
      JSON.stringify({ event: { id: 'evt_not_mine', eventType: 'checkout.order.approved', at: 0, resourceId: 'ORDNOTMINE', payload: {} } }),
    );
    expect(notMine).toBeNull();

    const before = snapshot.messages.length;
    const event: GatewayEvent = {
      id: 'evt_real',
      eventType: 'checkout.order.completed',
      at: Date.UTC(2026, 9, 13, 15, 0, 0),
      resourceId: orderId,
      payload: { status: 'COMPLETED' },
    };
    const verified = await gateway!.verifyWebhook({ 'paypal-auth-algo': 'sim' }, JSON.stringify({ event }));
    expect(verified).not.toBeNull();
    const delivered = deliverEvent(verified!);
    expect(delivered).toEqual({ id, matched: true });
    expect(floorSnapshot(id).snapshot.messages.length).toBe(before + 1);
    expect(floorSnapshot(id).snapshot.messages.at(-1)!.type).toBe('webhook.received');
  });

  it('says which floor a webhook belongs to, and admits when it belongs to none', async () => {
    const { id } = await floor('unmatched-webhook', { instruments: ['coffee-green'] });
    await stepFloor(id);
    const stranger: GatewayEvent = {
      id: 'evt_stranger',
      eventType: 'capture.completed',
      at: Date.UTC(2026, 9, 13, 15, 0, 0),
      resourceId: 'ORD99999999',
      payload: {},
    };
    expect(deliverEvent(stranger)).toEqual({ id: '', matched: false });
    const whoever = webhookGateway();
    expect(whoever).not.toBeNull();
    expect(whoever!.mode).toBe('sim');
  });

  it('suggests a different seed every time', () => {
    expect(suggestedSeed()).not.toBe(suggestedSeed());
    expect(suggestedSeed()).toMatch(/^[0-9a-f-]{8}$/);
  });
});
