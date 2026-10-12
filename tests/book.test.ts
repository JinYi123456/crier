import { describe, expect, it } from 'vitest';
import { Book, type Fill, type RestingOrder } from '../src/core/book';

const T = 1_700_000_000_000;

function askOver(book: Book, party: string, price: number, qty: number, ts = T) {
  return book.place({ party, side: 'sell', priceMinor: price, qty, ts });
}

function bidOver(book: Book, party: string, price: number, qty: number, ts = T) {
  return book.place({ party, side: 'buy', priceMinor: price, qty, ts });
}

describe('matching', () => {
  it('keeps track of what each party has tied up on the board', () => {
    const book = new Book('ceramic-mug', { tickSizeMinor: 50 });
    expect(book.committedFor('buyer-kestrel')).toEqual({ minor: 0, qty: 0 });

    bidOver(book, 'buyer-kestrel', 100_00, 3);
    expect(book.committedFor('buyer-kestrel')).toEqual({ minor: 300_00, qty: 3 });

    const ask = askOver(book, 'seller-onyx', 140_00, 2);
    expect(book.committedFor('seller-onyx')).toEqual({ minor: 0, qty: 2 });

    // Half of the bid is taken: only what is still live stays committed.
    bidOver(book, 'buyer-kestrel', 140_00, 2);
    expect(ask.order.remaining).toBe(0);
    expect(book.committedFor('seller-onyx')).toEqual({ minor: 0, qty: 0 });
    expect(book.committedFor('buyer-kestrel')).toEqual({ minor: 300_00, qty: 3 });
  });

  it('rests an order that crosses nothing', () => {
    const book = new Book('ceramic-mug', { tickSizeMinor: 50 });
    const result = askOver(book, 'seller-onyx', 120_00, 5);
    expect(result.fills).toEqual([]);
    expect(result.rejected).toBeNull();
    expect(book.best()).toEqual({ bidMinor: null, askMinor: 120_00, spreadMinor: null, midMinor: null });
    expect(book.resting).toHaveLength(1);
  });

  it('takes at the resting price, never better', () => {
    const book = new Book('ceramic-mug', { tickSizeMinor: 50 });
    askOver(book, 'seller-onyx', 120_00, 5);
    const result = bidOver(book, 'buyer-kestrel', 130_00, 2);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.priceMinor).toBe(120_00);
    expect(result.fills[0]?.qty).toBe(2);
    expect(result.fills[0]?.aggressor).toBe('buy');
    expect(result.fills[0]?.maker).toBe('seller-onyx');
    expect(result.order.remaining).toBe(0);
  });

  it('serves the best price first, then whoever called it first', () => {
    const book = new Book('ceramic-mug');
    const lateCheap = askOver(book, 'seller-late', 100, 1, T + 5_000);
    const earlyCheap = askOver(book, 'seller-early', 100, 1, T + 1_000);
    askOver(book, 'seller-pricey', 110, 1, T + 500);
    const fills = bidOver(book, 'buyer', 110, 2).fills;
    expect(fills.map((f) => f.seller)).toEqual(['seller-early', 'seller-late']);
    expect(lateCheap.order.remaining).toBe(0);
    expect(earlyCheap.order.remaining).toBe(0);
    expect(book.best().askMinor).toBe(110);
  });

  it('fills part of a big order and leaves the rest on the board', () => {
    const book = new Book('ceramic-mug');
    askOver(book, 'seller-onyx', 100, 3);
    const result = bidOver(book, 'buyer-kestrel', 100, 10);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.qty).toBe(3);
    expect(result.order.remaining).toBe(7);
    expect(book.best().bidMinor).toBe(100);
    expect(book.find(result.order.id)?.remaining).toBe(7);
  });

  it('will not let an agent trade with itself, and leaves its own quote standing', () => {
    const book = new Book('ceramic-mug');
    askOver(book, 'ghost', 100, 4);
    askOver(book, 'honest-seller', 105, 4);
    const result = bidOver(book, 'ghost', 110, 6);
    expect(result.fills.map((f) => f.seller)).toEqual(['honest-seller']);
    expect(result.fills[0]?.qty).toBe(4);
    const stillThere = book.resting.filter((o) => o.party === 'ghost' && o.side === 'sell');
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]?.remaining).toBe(4);
  });

  it('cancels a resting order and withdraws everything for a party', () => {
    const book = new Book('ceramic-mug');
    const a = askOver(book, 'seller-onyx', 100, 2);
    askOver(book, 'seller-onyx', 110, 2);
    expect(book.cancel(a.order.id, 'seller-onyx')).toBe(true);
    expect(book.cancel(a.order.id)).toBe(false);
    expect(book.cancelFor('seller-onyx')).toHaveLength(1);
    expect(book.resting).toHaveLength(0);
  });

  it('refuses nonsense and off-tick prices', () => {
    const book = new Book('ceramic-mug', { tickSizeMinor: 25 });
    expect(bidOver(book, 'x', 0, 1).rejected).toBe('non_positive_price');
    expect(bidOver(book, 'x', 100, 0).rejected).toBe('non_positive_qty');
    expect(bidOver(book, 'x', 101, 1).rejected).toBe('wrong_tick');
    expect(book.resting).toHaveLength(0);
  });

  it('immediate-or-cancel takes what it can and expires the rest', () => {
    const book = new Book('ceramic-mug');
    askOver(book, 'seller-onyx', 100, 2);
    const partial = book.place({ party: 'buyer', side: 'buy', priceMinor: 100, qty: 5, ts: T, kind: 'ioc' });
    expect(partial.fills.map((f: Fill) => f.qty)).toEqual([2]);
    expect(partial.expiredQty).toBe(3);
    expect(partial.rejected).toBeNull();
    expect(book.resting.filter((o) => o.side === 'buy')).toHaveLength(0);

    const nothing = book.place({ party: 'buyer-2', side: 'buy', priceMinor: 90, qty: 1, ts: T, kind: 'ioc' });
    expect(nothing.rejected).toBe('nothing_to_cross_ioc');
    expect(nothing.fills).toEqual([]);
    expect(book.find(nothing.order.id)).toBeUndefined();
  });

  it('collapses the ladder into levels and reports the midpoint', () => {
    const book = new Book('ceramic-mug');
    askOver(book, 's1', 110, 2);
    askOver(book, 's2', 110, 3);
    askOver(book, 's3', 120, 1);
    bidOver(book, 'b1', 100, 4);
    bidOver(book, 'b2', 95, 1);
    const depth = book.depth(4);
    expect(depth.asks).toEqual([
      { priceMinor: 110, qty: 5, orders: 2 },
      { priceMinor: 120, qty: 1, orders: 1 },
    ]);
    expect(depth.bids[0]).toEqual({ priceMinor: 100, qty: 4, orders: 1 });
    expect(book.best()).toEqual({ bidMinor: 100, askMinor: 110, spreadMinor: 10, midMinor: 105 });
  });

  it('survives a serialise and restore round trip with the same state', () => {
    const book = new Book('ceramic-mug', { tickSizeMinor: 5 });
    askOver(book, 's1', 100, 3);
    bidOver(book, 'b1', 90, 5);
    const restored = Book.fromJSON(book.toJSON());
    expect(restored.resting.map((o: RestingOrder) => [o.party, o.priceMinor, o.remaining])).toEqual(
      book.resting.map((o) => [o.party, o.priceMinor, o.remaining]),
    );
    expect(restored.best()).toEqual(book.best());
    expect(restored.tickSizeMinor).toBe(5);
  });

  it('is deterministic: the same script gives the same ids', () => {
    const run = () => {
      const book = new Book('ceramic-mug');
      askOver(book, 's', 100, 2, T);
      return bidOver(book, 'b', 100, 1, T + 1).fills[0]?.id;
    };
    expect(run()).toBe(run());
  });
});
