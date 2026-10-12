import { describe, expect, it } from 'vitest';
import { ACCOUNT } from '../src/core/books';
import { DEFAULT_INSTRUMENTS, Session, type SessionConfig } from '../src/core/world';

type OpenOptions = Omit<SessionConfig, 'seed'>;

async function openSession(seed: string, options: OpenOptions = {}): Promise<Session> {
  return Session.open({ ...options, seed });
}

async function runSession(seed: string, options: OpenOptions = {}): Promise<Session> {
  const session = await openSession(seed, options);
  await session.run();
  return session;
}

function openGrossMinor(session: Session): number {
  return session.trades
    .filter((trade) => trade.phase === 'funded' || trade.phase === 'captured')
    .reduce((sum, trade) => sum + trade.grossMinor, 0);
}

describe('a session of the floor', () => {
  it('is a pure function of its seed', async () => {
    const first = await runSession('determinism-seed');
    const second = await runSession('determinism-seed');
    expect(second.chain.headHash).toBe(first.chain.headHash);
    expect(second.report()).toEqual(first.report());
    expect(JSON.stringify(second.snapshot())).toBe(JSON.stringify(first.snapshot()));
  });

  it('changes the market when the seed changes', async () => {
    const first = await runSession('determinism-seed');
    const second = await runSession('another-seed');
    expect(second.chain.headHash).not.toBe(first.chain.headHash);
  });

  it('opens on the default instruments and seats both sides of each', async () => {
    const session = await openSession('opening-seed');
    expect(session.marketsView.map((market) => market.instrument.id)).toEqual([...DEFAULT_INSTRUMENTS]);
    for (const market of session.marketsView) {
      const buyers = market.participants.filter((participant) => participant.spec.role === 'buy');
      const sellers = market.participants.filter((participant) => participant.spec.role === 'sell');
      expect(buyers.length).toBe(4);
      expect(sellers.length).toBe(4);
      // A buyer that starts under its ceiling and a seller that starts over its floor is the
      // only way a session can have a deal to find at all.
      for (const buyer of buyers) expect(buyer.spec.targetMinor).toBeLessThanOrEqual(buyer.spec.reservationMinor);
      for (const seller of sellers) expect(seller.spec.targetMinor).toBeGreaterThanOrEqual(seller.spec.reservationMinor);
    }
    const opened = session.chain.messages[0];
    expect(opened?.type).toBe('market.open');
    expect(opened?.payload.feed).toBe('bundled');
  });

  it('refuses an instrument the session cannot settle', async () => {
    await expect(Session.open({ seed: 'mixed-currency', instrumentIds: ['coffee-green', 'olive-oil'] })).rejects.toThrow(/settles in USD/);
    await expect(Session.open({ seed: 'x' })).rejects.toThrow(/seed is required/);
  });

  it('gets to a real number of trades and closes the books', async () => {
    const session = await runSession('full-session-seed');
    const report = session.report();
    expect(session.closed).toBe(true);
    expect(report.trades).toBeGreaterThan(5);
    expect(report.fills).toBe(report.trades);
    expect(report.ticks).toBeLessThanOrEqual(12);
    expect(report.messages).toBeGreaterThan(100);
    expect(report.volumeMinor).toBe(session.trades.reduce((sum, trade) => sum + trade.grossMinor, 0));
    expect(report.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('closes the tape with a market.close and refuses to keep going', async () => {
    const session = await runSession('closed-seed');
    const last = session.chain.messages[session.chain.messages.length - 1];
    expect(last?.type).toBe('market.close');
    await expect(session.step()).rejects.toThrow(/closed/);
    await session.close();
    expect(session.chain.messages.filter((message) => message.type === 'market.close')).toHaveLength(1);
  });
});

describe('what the floor is allowed to say', () => {
  it('never lets an agent quote past its own reservation', async () => {
    const session = await runSession('reservation-seed');
    const byParty = new Map(session.roster.map((participant) => [participant.spec.id, participant]));
    const quotes = session.chain.messages.filter((message) => message.type === 'floor.quote');
    expect(quotes.length).toBeGreaterThan(50);
    for (const message of quotes) {
      const party = byParty.get(String(message.payload.party));
      if (!party) throw new Error(`the tape quotes for ${String(message.payload.party)}, who was never seated`);
      const priceMinor = Number(message.payload.priceMinor);
      if (message.payload.side === 'buy') {
        expect(priceMinor).toBeLessThanOrEqual(party.spec.reservationMinor);
      } else {
        expect(priceMinor).toBeGreaterThanOrEqual(party.spec.reservationMinor);
      }
    }
  });

  it('never spends money or stock an agent does not have', async () => {
    const session = await runSession('budget-seed');
    for (const participant of session.roster) {
      if (participant.spec.role === 'buy') {
        expect(participant.state.spentMinor, `${participant.spec.id} overspent`).toBeLessThanOrEqual(participant.spec.budgetMinor ?? 0);
      } else {
        expect(participant.state.soldQty, `${participant.spec.id} sold what it does not hold`).toBeLessThanOrEqual(participant.spec.inventory ?? 0);
      }
    }
  });

  it('prints only on whole ticks of the instrument', async () => {
    const session = await runSession('tick-seed');
    const tickOf = new Map(session.marketsView.map((market) => [market.instrument.id, market.instrument.tickSizeMinor]));
    for (const trade of session.trades) {
      const tick = tickOf.get(trade.instrument) ?? 1;
      expect(trade.priceMinor % tick).toBe(0);
      expect(trade.grossMinor).toBe(trade.priceMinor * trade.qty);
      expect(trade.currency).toBe('USD');
    }
  });

  it('signs every message with a key the session actually holds', async () => {
    const session = await runSession('signing-seed');
    const verification = session.report().verification;
    expect(verification.ok).toBe(true);
    expect(verification.findings).toHaveLength(0);
    expect(new Set(session.chain.messages.map((message) => message.actor)).size).toBeGreaterThan(10);
  });
});

describe('the money behind the market', () => {
  it('leaves escrow holding exactly the trades that have not been paid out', async () => {
    const session = await runSession('escrow-seed');
    expect(session.ledger.balanceOf(ACCOUNT.escrow)).toBe(openGrossMinor(session));
    expect(session.ledger.balanceOf(ACCOUNT.feeRevenue)).toBe(session.report().feeMinor);
  });

  it('keeps the books balanced and free of audit findings', async () => {
    const session = await runSession('ledger-seed');
    expect(session.ledger.isBalanced()).toBe(true);
    expect(session.ledger.audit()).toEqual([]);
  });

  it('holds some trades for a human without stalling the floor', async () => {
    const session = await runSession('veto-seed');
    const report = session.report();
    expect(report.trades).toBeGreaterThan(10);
    // The veto layer has to be selective, or it is just a queue nobody reads.
    expect(report.heldAtClose).toBeGreaterThan(0);
    expect(report.heldAtClose).toBeLessThan(report.trades / 2);
    expect(session.heldTrades.every((trade) => trade.phase === 'funded' && trade.vetoRules.length > 0)).toBe(true);
  });

  it('pays a released trade out and voids a vetoed one', async () => {
    const session = await runSession('human-seed');
    const [release, veto] = session.heldTrades;
    expect(release, 'the session should produce trades to rule on').toBeDefined();

    if (release) {
      const before = session.ledger.balanceOf(ACCOUNT.escrow);
      const settled = await session.releaseTrade(release.id, 'checked the counterparty, fine');
      expect(settled.phase).toBe('paid_out');
      expect(settled.held).toBe(false);
      expect(session.ledger.balanceOf(ACCOUNT.escrow)).toBe(before - settled.grossMinor);
    }
    if (veto) {
      const before = session.ledger.balanceOf(ACCOUNT.escrow);
      const voided = await session.vetoTrade(veto.id, 'not this pairing');
      expect(voided.phase).toBe('voided');
      expect(session.ledger.balanceOf(ACCOUNT.escrow)).toBe(before - voided.grossMinor);
    }

    const verification = session.report().verification;
    expect(verification.ok).toBe(true);
    const ruled = session.chain.messages.filter((message) => message.actor === 'human');
    expect(ruled.length).toBeGreaterThan(0);
    expect(ruled.every((message) => message.type === 'human.release' || message.type === 'human.veto')).toBe(true);
  });

  it('drains the payout batch when the session is closed', async () => {
    const session = await runSession('batched-seed', { payoutMode: 'batched' });
    expect(session.ledger.balanceOf(ACCOUNT.escrow)).toBe(openGrossMinor(session));
    expect(session.settler.summary().pendingPayoutMinor).toBe(0);
  });

  it('refunds a settled trade out of the settlement bank', async () => {
    const session = await runSession('refund-seed');
    const paid = session.trades.find((trade) => trade.phase === 'paid_out');
    if (!paid) throw new Error('no trade reached paid_out');
    const refunded = await session.refundTrade(paid.id, paid.grossMinor, 'buyer never received the lot');
    expect(refunded.phase).toBe('refunded');
    expect(refunded.refundedMinor).toBe(paid.grossMinor);
    expect(session.ledger.isBalanced()).toBe(true);
    expect(session.ledger.audit()).toEqual([]);
    expect(session.report().verification.ok).toBe(true);
  });
});

describe('what the screen is handed', () => {
  it('serialises to JSON and back without losing anything', async () => {
    const session = await runSession('snapshot-seed');
    const snapshot = session.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.messages).toHaveLength(session.chain.messages.length);
    expect(snapshot.trades.every((trade) => trade.messages.length > 0)).toBe(true);
    expect(snapshot.participants).toHaveLength(session.roster.length);
  });

  it('reports the pressure on an agent so the pit can draw it', async () => {
    const session = await openSession('pressure-seed');
    const participant = session.roster[0];
    if (!participant) throw new Error('nobody was seated');
    expect(session.pressureFor(participant.spec.id)).toBe(0);
    await session.step();
    expect(session.pressureFor(participant.spec.id)).toBeGreaterThan(0);
    expect(session.pressureFor('nobody-on-the-floor')).toBe(0);
  });

  it('shows a book that agrees with itself', async () => {
    const session = await runSession('depth-seed');
    for (const market of session.marketsView) {
      const inDepth =
        market.depth.bids.reduce((sum, level) => sum + level.orders, 0) +
        market.depth.asks.reduce((sum, level) => sum + level.orders, 0);
      expect(inDepth).toBe(market.resting.length);
      if (market.best.bidMinor !== null && market.best.askMinor !== null) {
        expect(market.best.bidMinor).toBeLessThan(market.best.askMinor);
      }
    }
  });
});
