import { Rng } from './rng';
import type { Best, OrderKind, Side } from './book';

/**
 * How an agent decides what to shout this tick.
 *
 * The negotiation is deterministic arithmetic, not a language model: a concession curve that
 * moves from an aspiration towards a secret walk-away as time runs out, a budget that cannot
 * be exceeded, and a rule for when to stop posting and simply take the best price on the
 * board. Two agents with overlapping ranges will cross; two without will never trade, and the
 * engine can say which happened and why.
 */

export type StrategyKind = 'patient' | 'urgent' | 'anchor' | 'volume' | 'holdout';

export interface AgentSpec {
  readonly id: string;
  readonly name: string;
  readonly role: Side;
  readonly instrument: string;
  /**
   * The buyer's highest acceptable price, or the seller's lowest. This is secret: no quote
   * will ever concede past it, and the audit trail proves it.
   */
  readonly reservationMinor: number;
  /** The price the agent hopes to open at. */
  readonly targetMinor: number;
  readonly horizonTicks: number;
  readonly strategy: StrategyKind;
  /** Buyers only: cash this agent may spend on this instrument, in minor units. */
  readonly budgetMinor?: number;
  /** Sellers only: units this agent is willing to part with. */
  readonly inventory?: number;
  readonly maxQtyPerTick: number;
  /** 0-1000 basis points of standing in the pit; affects how much risk the agent will carry. */
  readonly reputationBps: number;
}

export interface AgentState {
  readonly spec: AgentSpec;
  spentMinor: number;
  soldQty: number;
  withdrawn: boolean;
  quotesShouted: number;
  roundsHeld: number;
  fillsAsTaker: number;
  fillsAsMaker: number;
}

export function newAgentState(spec: AgentSpec): AgentState {
  return {
    spec,
    spentMinor: 0,
    soldQty: 0,
    withdrawn: false,
    quotesShouted: 0,
    roundsHeld: 0,
    fillsAsTaker: 0,
    fillsAsMaker: 0,
  };
}

/** Patience shapes the curve: >1 holds the line and concedes late, <1 gives ground early. */
const PATIENCE: Record<StrategyKind, number> = {
  patient: 2.6,
  urgent: 0.55,
  anchor: 3.4,
  volume: 1.35,
  holdout: 4.2,
};

export interface Quote {
  readonly side: Side;
  readonly priceMinor: number;
  readonly qty: number;
  readonly kind: OrderKind;
  readonly reason: string;
  readonly voice: string;
  readonly urgency: number;
}

export function remainingBudget(state: AgentState): number {
  if (state.spec.role !== 'buy') return Number.POSITIVE_INFINITY;
  return Math.max(0, (state.spec.budgetMinor ?? 0) - state.spentMinor);
}

export function remainingInventory(state: AgentState): number {
  if (state.spec.role !== 'sell') return Number.POSITIVE_INFINITY;
  return Math.max(0, (state.spec.inventory ?? 0) - state.soldQty);
}

export function hasZopa(buyer: AgentSpec, seller: AgentSpec): boolean {
  return buyer.reservationMinor >= seller.reservationMinor;
}

/** Where the agent stands at `tick` on its concession curve, in [0,1]. */
export function concessionProgress(state: AgentState, tick: number): number {
  const horizon = Math.max(1, state.spec.horizonTicks);
  const elapsed = Math.min(1, Math.max(0, tick / horizon));
  const k = PATIENCE[state.spec.strategy];
  return Math.pow(elapsed, k);
}

function roundToTick(value: number, tickSize: number, side: Side, reservation: number): number {
  const steps = side === 'buy' ? Math.floor(value / tickSize) : Math.ceil(value / tickSize);
  const price = steps * tickSize;
  return side === 'buy' ? Math.min(price, roundDown(reservation, tickSize)) : Math.max(price, roundUp(reservation, tickSize));
}

function roundDown(value: number, tickSize: number): number {
  return Math.floor(value / tickSize) * tickSize;
}

function roundUp(value: number, tickSize: number): number {
  return Math.ceil(value / tickSize) * tickSize;
}

export interface QuoteInput {
  readonly state: AgentState;
  readonly tick: number;
  readonly tickSizeMinor: number;
  readonly best: Best;
  readonly rng: Rng;
  /** Minor units of surplus an agent insists on keeping before it will cross the spread. */
  readonly minMarginMinor?: number;
  /** Cash already tied up in this buyer's resting orders. */
  readonly committedMinor?: number;
  /** Units already tied up in this seller's resting orders. */
  readonly committedQty?: number;
}

/**
 * Produce this tick's call, or null when the agent has nothing left to say.
 */
export function quoteFor(input: QuoteInput): Quote | null {
  const { state, tick, tickSizeMinor, best, rng } = input;
  const spec = state.spec;
  if (state.withdrawn) return null;
  if (tick > spec.horizonTicks) {
    state.withdrawn = true;
    return null;
  }
  // What an agent may still commit is what it has left *after* the orders already on the board:
  // shouting a second bid against cash that is resting on the book would overspend the budget.
  const inventory = remainingInventory(state) - (input.committedQty ?? 0);
  const budget = remainingBudget(state) - (input.committedMinor ?? 0);
  if (spec.role === 'sell' && inventory <= 0) return null;
  if (spec.role === 'buy' && budget <= 0) return null;

  const alpha = concessionProgress(state, tick);
  const raw = spec.targetMinor + (spec.reservationMinor - spec.targetMinor) * alpha;
  const noiseBps = spec.strategy === 'anchor' ? 25 : 90;
  const noisy = rng.jitterBps(Math.round(raw), noiseBps);
  const price = roundToTick(noisy, tickSizeMinor, spec.role, spec.reservationMinor);

  let qty = Math.max(1, Math.min(spec.maxQtyPerTick, spec.role === 'sell' ? inventory : Math.floor(budget / Math.max(1, price))));
  if (spec.role === 'buy' && qty * price > budget) qty = Math.floor(budget / price);
  if (qty <= 0) return null;

  state.quotesShouted += 1;
  const urgency = alpha;

  // Crossing the board: an agent that can still make a surplus takes rather than waits, and
  // gets bolder the closer it is to walking away empty-handed.
  const minMargin = input.minMarginMinor ?? tickSizeMinor;
  const standing = best.bidMinor !== null && best.askMinor !== null;
  if (standing && spec.role === 'buy' && best.askMinor !== null) {
    const ask = best.askMinor;
    const surplus = spec.reservationMinor - ask;
    const tolerance = minMargin + Math.round((1 - urgency) * minMargin * 4);
    if (surplus >= tolerance) {
      const affordable = Math.floor(budget / ask);
      const takeQty = Math.max(1, Math.min(qty, affordable));
      if (takeQty * ask <= budget && ask <= spec.reservationMinor) {
        return {
          side: 'buy',
          priceMinor: ask,
          qty: takeQty,
          kind: 'ioc',
          reason: surplus >= tolerance * 3 ? 'crossing_spread' : 'closing_before_horizon',
          voice: `${spec.name} takes ${ask} x${takeQty}`,
          urgency,
        };
      }
    }
  }
  if (standing && spec.role === 'sell' && best.bidMinor !== null) {
    const bid = best.bidMinor;
    const surplus = bid - spec.reservationMinor;
    const tolerance = minMargin + Math.round((1 - urgency) * minMargin * 4);
    if (surplus >= tolerance && bid >= spec.reservationMinor) {
      const sellQty = Math.max(1, Math.min(qty, inventory));
      return {
        side: 'sell',
        priceMinor: bid,
        qty: sellQty,
        kind: 'ioc',
        reason: surplus >= tolerance * 3 ? 'crossing_spread' : 'closing_before_horizon',
        voice: `${spec.name} hits ${bid} x${sellQty}`,
        urgency,
      };
    }
  }

  const kind: OrderKind = 'limit';
  const voice =
    spec.role === 'buy'
      ? `${spec.name} bids ${price} for ${qty}`
      : `${spec.name} offers ${price} x${qty}`;

  return { side: spec.role, priceMinor: price, qty, kind, reason: urgency > 0.75 ? 'late_concession' : 'curve', voice, urgency };
}

export interface StandingsInput {
  readonly state: AgentState;
  readonly tick: number;
  readonly best: Best;
}

/** Why an agent left the floor on its own - reported so the tape can explain a silent corner. */
export function walkAwayReason(input: StandingsInput): string | null {
  const { state, tick, best } = input;
  const spec = state.spec;
  if (spec.role === 'buy') {
    if (remainingBudget(state) <= 0) return 'budget exhausted';
    if (best.askMinor !== null && best.askMinor > spec.reservationMinor) return 'no seller above my ceiling';
  } else {
    if (remainingInventory(state) <= 0) return 'sold out';
    if (best.bidMinor !== null && best.bidMinor < spec.reservationMinor) return 'no bid at my floor';
  }
  if (tick > spec.horizonTicks) return 'horizon passed without a match';
  return null;
}

export function surplusFor(state: AgentState, priceMinor: number): number {
  return state.spec.role === 'buy' ? state.spec.reservationMinor - priceMinor : priceMinor - state.spec.reservationMinor;
}

/** A short, deterministic human-readable line for the tape. */
export function describeStrategy(strategy: StrategyKind): string {
  switch (strategy) {
    case 'patient':
      return 'patient - concedes late, holds the line until the horizon nears';
    case 'urgent':
      return 'urgent - gives ground early to get done';
    case 'anchor':
      return 'anchor - extreme opening ask/bid, tiny steps, low noise';
    case 'volume':
      return 'volume - cares about units moved more than price';
    case 'holdout':
      return 'holdout - will walk rather than move';
    default:
      return strategy;
  }
}
