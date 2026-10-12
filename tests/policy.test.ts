import { describe, expect, it } from 'vitest';
import { Book } from '../src/core/book';
import { Rng } from '../src/core/rng';
import {
  concessionProgress,
  describeStrategy,
  hasZopa,
  newAgentState,
  quoteFor,
  remainingBudget,
  remainingInventory,
  surplusFor,
  walkAwayReason,
  type AgentSpec,
} from '../src/core/policy';

const T0 = 1_700_000_000_000;

function buyer(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'kestrel',
    name: 'KESTREL',
    role: 'buy',
    instrument: 'ceramic-mug',
    reservationMinor: 120_00,
    targetMinor: 80_00,
    horizonTicks: 12,
    strategy: 'patient',
    budgetMinor: 600_00,
    maxQtyPerTick: 3,
    reputationBps: 700,
    ...overrides,
  };
}

function seller(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'onyx',
    name: 'ONYX',
    role: 'sell',
    instrument: 'ceramic-mug',
    reservationMinor: 90_00,
    targetMinor: 140_00,
    horizonTicks: 12,
    strategy: 'anchor',
    inventory: 6,
    maxQtyPerTick: 2,
    reputationBps: 820,
    ...overrides,
  };
}

const emptyBest = { bidMinor: null, askMinor: null, spreadMinor: null, midMinor: null };

describe('what an agent may still commit', () => {
  it('subtracts cash already resting on the board from a buyer', () => {
    const spec = buyer({ budgetMinor: 300_00, maxQtyPerTick: 3 });
    const state = newAgentState(spec);
    const alone = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'alone') });
    expect(alone).not.toBeNull();

    // The same agent with its whole budget already quoted cannot add another bid.
    const committed = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'committed'), committedMinor: 300_00 });
    expect(committed).toBeNull();

    const part = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'part'), committedMinor: 200_00 });
    if (!part) throw new Error('an agent with 100_00 left should still be able to bid');
    expect(part.qty * part.priceMinor).toBeLessThanOrEqual(100_00);
  });

  it('subtracts units already resting on the board from a seller', () => {
    const spec = seller({ inventory: 4, maxQtyPerTick: 3 });
    const state = newAgentState(spec);
    const first = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'first') });
    if (!first) throw new Error('a seller with stock should quote');
    expect(first.qty).toBeLessThanOrEqual(4);

    const held = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'held'), committedQty: 3 });
    if (held) expect(held.qty).toBeLessThanOrEqual(1);

    const soldOut = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng: new Rng('t', 'out'), committedQty: 4 });
    expect(soldOut).toBeNull();
  });
});

function callFor(spec: AgentSpec, tick: number, rng: Rng, best = emptyBest, tickSize = 100) {
  return quoteFor({ state: newAgentState(spec), tick, tickSizeMinor: tickSize, best, rng });
}

describe('concession curves', () => {
  it('moves from aspiration toward the secret ceiling and never past it', () => {
    const rng = new Rng('curve', 'seed');
    const spec = buyer();
    const prices: number[] = [];
    for (let tick = 0; tick <= spec.horizonTicks; tick += 1) {
      const quote = callFor(spec, tick, rng);
      expect(quote).not.toBeNull();
      prices.push((quote as { priceMinor: number }).priceMinor);
    }
    expect(prices[0]).toBeLessThanOrEqual(spec.reservationMinor);
    expect(Math.max(...prices)).toBeLessThanOrEqual(spec.reservationMinor);
    expect(prices[prices.length - 1]).toBeGreaterThan(spec.targetMinor);
  });

  it('keeps a seller above its floor and a buyer below its ceiling at every tick', () => {
    const rng = new Rng('curve', 'seed-2');
    const sell = seller();
    for (let tick = 0; tick <= sell.horizonTicks; tick += 1) {
      const quote = callFor(sell, tick, rng);
      expect((quote as { priceMinor: number }).priceMinor).toBeGreaterThanOrEqual(sell.reservationMinor);
    }
    expect(concessionProgress(newAgentState(sell), 0)).toBe(0);
    expect(concessionProgress(newAgentState(sell), sell.horizonTicks)).toBeCloseTo(1, 10);
  });

  it('is patient late and urgent early', () => {
    const patient = newAgentState(buyer({ strategy: 'patient' }));
    const urgent = newAgentState(buyer({ strategy: 'urgent' }));
    expect(concessionProgress(urgent, 2)).toBeGreaterThan(concessionProgress(patient, 2));
    expect(concessionProgress(patient, 10)).toBeGreaterThan(concessionProgress(urgent, 3));
    expect(describeStrategy('holdout')).toMatch(/walk rather than move/);
  });
});

describe('limits that cannot be broken', () => {
  it('never asks a buyer to spend more than it has', () => {
    const rng = new Rng('budget', 'seed');
    const spec = buyer({ budgetMinor: 150_00, reservationMinor: 120_00, targetMinor: 100_00, strategy: 'urgent' });
    const state = newAgentState(spec);
    for (let tick = 0; tick <= spec.horizonTicks; tick += 1) {
      const quote = quoteFor({ state, tick, tickSizeMinor: 100, best: emptyBest, rng });
      if (!quote) break;
      expect(quote.priceMinor * quote.qty).toBeLessThanOrEqual(remainingBudget(state));
      expect(quote.priceMinor).toBeLessThanOrEqual(spec.reservationMinor);
    }
  });

  it('runs out of inventory and stops speaking', () => {
    const rng = new Rng('stock', 'seed');
    const spec = seller({ inventory: 3, maxQtyPerTick: 2 });
    const state = newAgentState(spec);
    const first = quoteFor({ state, tick: 1, tickSizeMinor: 100, best: emptyBest, rng });
    expect(first?.qty).toBeLessThanOrEqual(3);
    state.soldQty = 3;
    expect(remainingInventory(state)).toBe(0);
    expect(quoteFor({ state, tick: 2, tickSizeMinor: 100, best: emptyBest, rng })).toBeNull();
  });

  it('withdraws past its horizon and says why', () => {
    const rng = new Rng('gone', 'seed');
    const spec = buyer({ horizonTicks: 4 });
    const state = newAgentState(spec);
    expect(quoteFor({ state, tick: 5, tickSizeMinor: 100, best: emptyBest, rng })).toBeNull();
    expect(state.withdrawn).toBe(true);
    expect(walkAwayReason({ state, tick: 5, best: emptyBest })).toBe('horizon passed without a match');

    const broke = newAgentState(buyer({ budgetMinor: 0 }));
    expect(walkAwayReason({ state: broke, tick: 1, best: emptyBest })).toBe('budget exhausted');

    const underpriced = newAgentState(buyer({ reservationMinor: 50_00 }));
    expect(
      walkAwayReason({ state: underpriced, tick: 1, best: { bidMinor: 40_00, askMinor: 90_00, spreadMinor: 50_00, midMinor: 65_00 } }),
    ).toBe('no seller above my ceiling');
  });

  it('knows when there is no deal to be had', () => {
    expect(hasZopa(buyer({ reservationMinor: 100 }), seller({ reservationMinor: 90 }))).toBe(true);
    expect(hasZopa(buyer({ reservationMinor: 80 }), seller({ reservationMinor: 90 }))).toBe(false);
    expect(surplusFor(newAgentState(buyer({ reservationMinor: 100 })), 85)).toBe(15);
    expect(surplusFor(newAgentState(seller({ reservationMinor: 100 })), 115)).toBe(15);
  });
});

describe('deciding to cross', () => {
  it('takes a passing ask when the surplus is worth it', () => {
    const rng = new Rng('cross', 'seed');
    const spec = buyer({ reservationMinor: 120_00, strategy: 'urgent', horizonTicks: 10 });
    const best = { bidMinor: 100_00, askMinor: 110_00, spreadMinor: 10_00, midMinor: 105_00 };
    const late = quoteFor({ state: newAgentState(spec), tick: 9, tickSizeMinor: 100, best, rng, minMarginMinor: 1_00 });
    expect(late?.kind).toBe('ioc');
    expect(late?.priceMinor).toBe(110_00);
    expect(late?.voice).toBe('KESTREL takes');
  });

  it('refuses to cross a price above its own ceiling however late it is', () => {
    const rng = new Rng('cross', 'seed');
    const spec = buyer({ reservationMinor: 100_00, strategy: 'urgent' });
    const best = { bidMinor: 99_00, askMinor: 120_00, spreadMinor: 21_00, midMinor: 109_50 };
    const quote = quoteFor({ state: newAgentState(spec), tick: 11, tickSizeMinor: 100, best, rng, minMarginMinor: 1_00 });
    expect(quote?.kind).toBe('limit');
    expect((quote?.priceMinor ?? 0)).toBeLessThanOrEqual(spec.reservationMinor);
  });
});

describe('two agents on a curve', () => {
  it('converge and cross inside a ZOPA, and never cross outside one', () => {
    const run = (sellerFloor: number) => {
      const book = new Book('ceramic-mug', { tickSizeMinor: 100 });
      const buySpec = buyer({ reservationMinor: 120_00, targetMinor: 90_00, horizonTicks: 20 });
      const sellSpec = seller({ reservationMinor: sellerFloor, targetMinor: 150_00, horizonTicks: 20 });
      const rng = new Rng('duel', String(sellerFloor));
      const buyState = newAgentState(buySpec);
      const sellState = newAgentState(sellSpec);
      let trades = 0;
      for (let tick = 1; tick <= 20; tick += 1) {
        for (const [state, spec] of [
          [buyState, buySpec],
          [sellState, sellSpec],
        ] as const) {
          const quote = quoteFor({ state, tick, tickSizeMinor: 100, best: book.best(), rng, minMarginMinor: 1_00 });
          if (!quote) continue;
          const result = book.place({
            party: spec.id,
            side: quote.side,
            priceMinor: quote.priceMinor,
            qty: quote.qty,
            ts: T0 + tick * 1_000,
            kind: quote.kind,
          });
          trades += result.fills.length;
          if (quote.side === 'buy') buyState.spentMinor += result.fills.reduce((s, f) => s + f.priceMinor * f.qty, 0);
          else sellState.soldQty += result.fills.reduce((s, f) => s + f.qty, 0);
        }
      }
      return { trades, book: book.best() };
    };

    const inside = run(90_00);
    expect(inside.trades).toBeGreaterThan(0);

    const outside = run(130_00);
    expect(outside.trades).toBe(0);
  });
});
