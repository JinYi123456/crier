import { describe, expect, it } from 'vitest';
import {
  FloorError,
  actOnFloorTrade,
  clampShape,
  closeFloor,
  deliverEvent,
  floorSnapshot,
  forgetFloors,
  openFloor,
  readPointer,
  runFloor,
  stepFloor,
  suggestedSeed,
  tamperFloor,
  webhookGateway,
} from '../src/server/floor';
import type { GatewayEvent } from '../src/gateway/types';
import type { FloorPointer } from '../src/server/floor';
import type { SessionSnapshot } from '../src/core/world';
import { pointerParams } from '../src/app/ui/pointer';
import { computeSealHash, keyringFrom, verifyChain } from '../src/core/protocol';
import { identityFromPublicKeyHex } from '../src/core/keys';
import { GET } from '../src/app/api/floor/[id]/tape/route';
import { GET as readFloor, POST } from '../src/app/api/floor/[id]/route';
import { POST as openFloorViaHttp } from '../src/app/api/floor/route';

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

  it('will not pretend to move money through a processor it has no standing with', async () => {
    // The hosted floor gets this question from a checkbox on the front door. The honest answer is that
    // this machine was never handed the credentials - not a crash, and not a simulation passed off as
    // the thing somebody asked for.
    const refusal = await openFloor(
      { seed: 'no-credentials-here', gateway: 'sandbox', maxTicks: 6 },
      { PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FloorError);
    expect((refusal as FloorError).status).toBe(422);
    expect((refusal as FloorError).message).toMatch(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);

    // The same floor on the local processor needs nothing and opens at once.
    const local = await openFloor({ seed: 'no-credentials-here', maxTicks: 6 });
    expect(local.session.snapshot().gateway).toBe('sim');
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

describe('the settlement desk', () => {
  function post(id: string, body: Record<string, unknown>, key?: string): Promise<Response> {
    return POST(new Request(`http://localhost/api/floor/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'x-operator-token': key }) },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
  }

  it('lets anybody ring the bell, and only the operator decide what happens to the money', async () => {
    process.env.OPERATOR_TOKEN = 'brass-key';
    try {
      const { id } = await floor('locked-desk', { instruments: ['coffee-green'], maxTicks: 3 });
      expect(floorSnapshot(id).locked).toBe(true);

      expect((await post(id, { action: 'step' })).status).toBe(200);

      const stranger = await post(id, { action: 'close' });
      expect(stranger.status).toBe(401);
      expect(((await stranger.json()) as { error: string }).error).toContain('operator key');

      expect((await post(id, { action: 'close' }, 'not-the-key')).status).toBe(401);
      expect((await post(id, { action: 'trade', tradeId: 'trade_nobody' })).status).toBe(401);

      const admitted = await post(id, { action: 'close' }, 'brass-key');
      expect(admitted.status).toBe(200);
    } finally {
      delete process.env.OPERATOR_TOKEN;
    }

    // With no key set the floor is entirely open, which is how it runs on your own machine.
    const { id } = await floor('open-desk', { instruments: ['coffee-green'], maxTicks: 3 });
    expect(floorSnapshot(id).locked).toBe(false);
    expect((await post(id, { action: 'close' })).status).toBe(200);
  });
});

/**
 * A room on a machine that never saw it.
 *
 * A deployment with no database has to answer this question, and the answer is the seed: the rounds
 * are a pure function of it and of the shape the id was hashed from, so a caller that quotes both can
 * be served by any machine, and the tape it gets is the same tape, line for line and seal for seal.
 */
describe('a floor that comes back from its pointer', () => {
  const shape = 'seed=rebuild-here&instruments=coffee-green&agents=4&ticks=4';

  function read(id: string, query: string): Promise<Response> {
    return readFloor(new Request(`http://localhost/api/floor/${id}?${query}`), { params: Promise.resolve({ id }) });
  }

  function send(id: string, body: Record<string, unknown>): Promise<Response> {
    return POST(
      new Request(`http://localhost/api/floor/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it('reads a pointer out of either a body or a URL, and refuses a catalogue with no such pit', () => {
    const fromUrl = readPointer(
      Object.fromEntries(new URLSearchParams('seed=brave-mill&instruments=coffee-green,saffron&agents=3&ticks=9&gateway=sandbox&payout=batched')),
    );
    expect(fromUrl).toEqual({
      seed: 'brave-mill',
      instruments: ['coffee-green', 'saffron'],
      agentsPerSide: 3,
      maxTicks: 9,
      gateway: 'sandbox',
      payoutMode: 'batched',
    });
    expect(readPointer({ seed: 'brave-mill', instruments: ['ceramic-mug'] })).toMatchObject({
      instruments: ['ceramic-mug'],
      agentsPerSide: 4,
      maxTicks: 12,
      gateway: 'sim',
    });
    expect(readPointer({})).toBeNull();
    expect(() => readPointer({ seed: 'brave-mill', instruments: 'sunset-boulevard' })).toThrow(FloorError);
    // The dials are small on purpose: a hand-typed URL must not be able to ask for a million rounds.
    expect(clampShape(99, 100_000)).toEqual({ agentsPerSide: 8, maxTicks: 60 });
    expect(clampShape(0, -4)).toEqual({ agentsPerSide: 1, maxTicks: 1 });
  });

  it('takes either spelling of a pointer for the same room', async () => {
    const ask = async (fields: Record<string, unknown>) => {
      const response = await openFloorViaHttp(
        new Request('http://localhost/api/floor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) }),
      );
      return (await response.json()) as { floor?: string; pointer?: FloorPointer; error?: string };
    };
    const short = await ask({ seed: 'two-dialects', instruments: 'coffee-green', agents: 3, ticks: 7, payout: 'batched' });
    expect(short.pointer).toEqual({
      seed: 'two-dialects',
      instruments: ['coffee-green'],
      agentsPerSide: 3,
      maxTicks: 7,
      gateway: 'sim',
      payoutMode: 'batched',
    });
    forgetFloors();
    const long = await ask({ seed: 'two-dialects', instruments: ['coffee-green'], agentsPerSide: 3, maxTicks: 7, payoutMode: 'batched' });
    // The short names belong in a URL, the long ones are what the engine calls them - either way the
    // room they hash to is the same room, and a shape quietly dropped to a default would not be.
    expect(long.floor).toBe(short.floor);
    const roundTrip = short.pointer === undefined ? null : readPointer(pointerParams(short.pointer));
    expect(roundTrip).toEqual(short.pointer);
    const bogus = await ask({ seed: 'two-dialects', instruments: 'sunset-boulevard' });
    expect(bogus.error).toContain('no instrument called');
  });

  it('brings a forgotten room back at the round its caller is standing at', async () => {
    const { id } = await floor('rebuild-here', { instruments: ['coffee-green'], maxTicks: 4 });
    await stepFloor(id);
    await stepFloor(id);
    const third = await stepFloor(id);
    expect(third.tick).toBe(3);
    const atThree = floorSnapshot(id, -1);
    const fourth = await stepFloor(id);
    const atFour = floorSnapshot(id, -1);

    forgetFloors();
    expect(() => floorSnapshot(id)).toThrow(FloorError);
    // A round nobody named means the opening, and this floor had three of them by then.
    expect((await read(id, `${shape}&since=-1`)).status).toBe(200);

    forgetFloors();
    const back = await read(id, `${shape}&round=1&since=-1`);
    expect(back.status).toBe(200);
    const one = (await back.json()) as { snapshot: SessionSnapshot; rebuilt?: boolean };
    expect(one.snapshot.tick).toBe(1);
    // The answer says it had to replay, so a caller is not left assuming the desk came with the room -
    // and a floor being opened at round nought is an opening, not a rebuild, so it says nothing.
    expect(one.rebuilt).toBe(true);
    const fresh = await read(id, `${shape}&since=-1`);
    expect(((await fresh.json()) as { rebuilt?: boolean }).rebuilt).toBe(false);
    const again = await read(id, `${shape}&round=1&since=-1`);
    expect(((await again.json()) as { rebuilt?: boolean }).rebuilt).toBe(false);

    // Ringing the bell on the rebuilt room carries on the same recording the unbroken one was on.
    forgetFloors();
    const stepped = await send(id, { action: 'step', seed: 'rebuild-here', instruments: 'coffee-green', agents: 4, ticks: 4, round: 2 });
    expect(stepped.status).toBe(200);
    expect(((await stepped.json()) as { result: { tick: number } }).result.tick).toBe(3);

    const now = await read(id, `${shape}&round=3&since=-1`);
    const body = (await now.json()) as { snapshot: SessionSnapshot };
    expect(JSON.stringify(body.snapshot.messages)).toBe(JSON.stringify(atThree.snapshot.messages));
    expect(body.snapshot.entries).toEqual(atThree.snapshot.entries);

    const ended = (await (await read(id, `${shape}&round=9&since=-1`)).json()) as { snapshot: SessionSnapshot };
    expect(ended.snapshot.tick).toBe(fourth.tick);
    expect(ended.snapshot.headHash).toBe(atFour.snapshot.headHash);
    const keyring = keyringFrom(ended.snapshot.messages.map((message) => identityFromPublicKeyHex(message.actor, message.key)));
    expect(verifyChain(ended.snapshot.messages, keyring).ok).toBe(true);
  });

  it('will not let one pointer open another room, and hands the tape anyway', async () => {
    const { id } = await floor('tape-after-amnesia', { instruments: ['coffee-green'], maxTicks: 3 });
    // Three rounds named out loud, not runFloor: that one stops early on a round that says nothing,
    // and the tape has to be compared against a room standing at a round both sides can count.
    await stepFloor(id);
    await stepFloor(id);
    await stepFloor(id);
    const head = floorSnapshot(id).snapshot.headHash;
    forgetFloors();

    const wrong = await read('crier_not_this_room', 'seed=tape-after-amnesia&instruments=coffee-green&ticks=3&round=3');
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: string }).error).toContain('does not name this room');

    const empty = await GET(new Request('http://localhost/api/floor/crier_x/tape?seed=not-a-seed-here'), { params: Promise.resolve({ id: 'crier_x' }) });
    expect(empty.status).toBe(404);

    const held = await GET(new Request(`http://localhost/api/floor/${id}/tape?seed=tape-after-amnesia&instruments=coffee-green&ticks=3&round=3`), {
      params: Promise.resolve({ id }),
    });
    expect(held.status).toBe(200);
    expect(((await held.json()) as SessionSnapshot).headHash).toBe(head);
  });
});
