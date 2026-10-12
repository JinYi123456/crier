import { derivedId } from './canonical';

/**
 * The matching engine for one instrument.
 *
 * Price-time priority, the rule every real pit runs on: the bid at the best price is served
 * first, and among equal prices whoever called it first is served first. A new order that
 * crosses takes at the *resting* price, so nobody is ever filled at a price better than the
 * one already on the board, and an order can never trade against its own owner.
 */

export type Side = 'buy' | 'sell';
export type OrderKind = 'limit' | 'ioc';

export interface OrderInput {
  readonly party: string;
  readonly side: Side;
  readonly priceMinor: number;
  readonly qty: number;
  readonly ts: number;
  readonly kind?: OrderKind;
  readonly reason?: string;
}

export interface RestingOrder {
  readonly id: string;
  readonly instrument: string;
  readonly party: string;
  readonly side: Side;
  readonly priceMinor: number;
  readonly qty: number;
  /** Unfilled quantity, which the engine decrements as the order is taken. */
  remaining: number;
  readonly ts: number;
  readonly entryIndex: number;
  readonly kind: OrderKind;
  readonly reason: string;
}

export interface Fill {
  readonly id: string;
  readonly instrument: string;
  readonly priceMinor: number;
  readonly qty: number;
  readonly ts: number;
  readonly buyOrder: string;
  readonly sellOrder: string;
  readonly buyer: string;
  readonly seller: string;
  readonly aggressor: Side;
  readonly maker: string;
}

export type RejectionCode =
  | 'non_positive_price'
  | 'non_positive_qty'
  | 'wrong_tick'
  | 'nothing_to_cross_ioc';

export interface PlaceResult {
  readonly order: RestingOrder;
  readonly fills: Fill[];
  readonly rejected: RejectionCode | null;
  /** Quantity that never rested because the order was immediate-or-cancel. */
  readonly expiredQty: number;
}

export interface BookOptions {
  readonly tickSizeMinor?: number;
}

export interface DepthLevel {
  readonly priceMinor: number;
  readonly qty: number;
  readonly orders: number;
}

export interface Best {
  readonly bidMinor: number | null;
  readonly askMinor: number | null;
  readonly spreadMinor: number | null;
  readonly midMinor: number | null;
}

export interface SerializedBook {
  readonly instrument: string;
  readonly tickSizeMinor: number;
  readonly bids: readonly RestingOrder[];
  readonly asks: readonly RestingOrder[];
  readonly entries: number;
}

export class Book {
  readonly instrument: string;
  readonly tickSizeMinor: number;
  private bids: RestingOrder[] = [];
  private asks: RestingOrder[] = [];
  private entries = 0;
  private readonly live = new Map<string, RestingOrder>();

  constructor(instrument: string, options: BookOptions = {}) {
    this.instrument = instrument;
    this.tickSizeMinor = Math.max(1, Math.round(options.tickSizeMinor ?? 1));
  }

  get resting(): RestingOrder[] {
    return [...this.bids, ...this.asks];
  }

  private sortBook(side: Side): void {
    const book = side === 'buy' ? this.bids : this.asks;
    const byTime = (a: RestingOrder, b: RestingOrder) => a.ts - b.ts || a.entryIndex - b.entryIndex || a.id.localeCompare(b.id);
    if (side === 'buy') book.sort((a, b) => b.priceMinor - a.priceMinor || byTime(a, b));
    else book.sort((a, b) => a.priceMinor - b.priceMinor || byTime(a, b));
  }

  best(): Best {
    const bid = this.bids[0]?.priceMinor ?? null;
    const ask = this.asks[0]?.priceMinor ?? null;
    if (bid === null || ask === null) return { bidMinor: bid, askMinor: ask, spreadMinor: null, midMinor: null };
    return { bidMinor: bid, askMinor: ask, spreadMinor: ask - bid, midMinor: Math.floor((ask + bid) / 2) };
  }

  depth(levels = 8): { bids: DepthLevel[]; asks: DepthLevel[] } {
    const collapse = (orders: readonly RestingOrder[], descending: boolean): DepthLevel[] => {
      const byPrice = new Map<number, { priceMinor: number; qty: number; orders: number }>();
      for (const order of orders) {
        const row = byPrice.get(order.priceMinor) ?? { priceMinor: order.priceMinor, qty: 0, orders: 0 };
        row.qty += order.remaining;
        row.orders += 1;
        byPrice.set(order.priceMinor, row);
      }
      const rows = [...byPrice.values()];
      rows.sort((a, b) => (descending ? b.priceMinor - a.priceMinor : a.priceMinor - b.priceMinor));
      return rows.slice(0, levels);
    };
    return { bids: collapse(this.bids, true), asks: collapse(this.asks, false) };
  }

  place(input: OrderInput): PlaceResult {
    const kind = input.kind ?? 'limit';
    const draft: RestingOrder = {
      id: derivedId('ord', this.instrument, input.party, input.side, input.ts, input.priceMinor, input.qty, this.entries),
      instrument: this.instrument,
      party: input.party,
      side: input.side,
      priceMinor: input.priceMinor,
      qty: input.qty,
      ts: input.ts,
      kind,
      reason: input.reason ?? '',
      remaining: input.qty,
      entryIndex: this.entries,
    };

    if (!Number.isInteger(input.priceMinor) || input.priceMinor <= 0) return refuse(draft, 'non_positive_price');
    if (!Number.isInteger(input.qty) || input.qty <= 0) return refuse(draft, 'non_positive_qty');
    if (input.priceMinor % this.tickSizeMinor !== 0) return refuse(draft, 'wrong_tick');

    this.entries += 1;
    const makers = input.side === 'buy' ? this.asks : this.bids;
    const fills: Fill[] = [];
    let cursor = 0;

    while (draft.remaining > 0 && cursor < makers.length) {
      const maker = makers[cursor] as RestingOrder;
      const crosses = input.side === 'buy' ? maker.priceMinor <= draft.priceMinor : maker.priceMinor >= draft.priceMinor;
      if (!crosses) break;
      // Trading with yourself is not a fill, it is a wash: leave that order on the board
      // untouched and look past it for a real counterparty.
      if (maker.party === draft.party) {
        cursor += 1;
        continue;
      }
      const qty = Math.min(draft.remaining, maker.remaining);
      fills.push(this.cross(draft, maker, qty));
      if (maker.remaining === 0) {
        makers.splice(cursor, 1);
        this.live.delete(maker.id);
      } else {
        cursor += 1;
      }
    }

    let expiredQty = 0;
    if (draft.remaining > 0) {
      if (kind === 'ioc') {
        expiredQty = draft.remaining;
        if (fills.length === 0) return { order: { ...draft, remaining: 0 }, fills, rejected: 'nothing_to_cross_ioc', expiredQty };
      } else {
        const book = draft.side === 'buy' ? this.bids : this.asks;
        book.push(draft);
        this.live.set(draft.id, draft);
        this.sortBook(draft.side);
      }
    }

    return { order: draft, fills, rejected: null, expiredQty };
  }

  private cross(taker: RestingOrder, maker: RestingOrder, qty: number): Fill {
    taker.remaining -= qty;
    maker.remaining -= qty;
    const buy = taker.side === 'buy' ? taker : maker;
    const sell = taker.side === 'buy' ? maker : taker;
    return {
      id: derivedId('fill', taker.id, maker.id, qty),
      instrument: this.instrument,
      // The maker's price wins: an aggressor never gets a better print than was already quoted.
      priceMinor: maker.priceMinor,
      qty,
      ts: taker.ts,
      buyOrder: buy.id,
      sellOrder: sell.id,
      buyer: buy.party,
      seller: sell.party,
      aggressor: taker.side,
      maker: maker.party,
    };
  }

  getOrders(): RestingOrder[] {
    return this.resting;
  }

  /**
   * What a party has already tied up in orders that are still on the board: cash for a buyer,
   * units for a seller. An agent cannot shout again against the same money, so the pit asks for
   * this before it lets one quote.
   */
  committedFor(party: string): { minor: number; qty: number } {
    let minor = 0;
    let qty = 0;
    for (const order of this.resting) {
      if (order.party !== party) continue;
      qty += order.remaining;
      if (order.side === 'buy') minor += order.remaining * order.priceMinor;
    }
    return { minor, qty };
  }

  find(orderId: string): RestingOrder | undefined {
    return this.live.get(orderId);
  }

  cancel(orderId: string, party?: string): boolean {
    const order = this.live.get(orderId);
    if (!order) return false;
    if (party !== undefined && order.party !== party) return false;
    const book = order.side === 'buy' ? this.bids : this.asks;
    const index = book.findIndex((candidate) => candidate.id === orderId);
    if (index >= 0) book.splice(index, 1);
    this.live.delete(orderId);
    return true;
  }

  /** Withdraw everything a party has resting - what an agent does when it changes its mind. */
  cancelFor(party: string): string[] {
    const ids = this.resting.filter((order) => order.party === party).map((order) => order.id);
    for (const id of ids) this.cancel(id);
    return ids;
  }

  toJSON(): SerializedBook {
    return {
      instrument: this.instrument,
      tickSizeMinor: this.tickSizeMinor,
      bids: this.bids.map((order) => ({ ...order })),
      asks: this.asks.map((order) => ({ ...order })),
      entries: this.entries,
    };
  }

  static fromJSON(data: SerializedBook): Book {
    const book = new Book(data.instrument, { tickSizeMinor: data.tickSizeMinor });
    book.bids = data.bids.map((order) => ({ ...order }));
    book.asks = data.asks.map((order) => ({ ...order }));
    book.entries = data.entries;
    for (const order of [...book.bids, ...book.asks]) book.live.set(order.id, order);
    book.sortBook('buy');
    book.sortBook('sell');
    return book;
  }
}

function refuse(order: RestingOrder, code: RejectionCode): PlaceResult {
  return { order: { ...order, remaining: 0 }, fills: [], rejected: code, expiredQty: 0 };
}
