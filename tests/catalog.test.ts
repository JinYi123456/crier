import { describe, expect, it } from 'vitest';
import {
  CATALOG_AS_OF,
  CatalogError,
  INSTRUMENTS,
  bundledFeed,
  catalogFingerprint,
  feedFromEnvironment,
  instrumentById,
  instrumentsInCurrency,
  liveFeed,
} from '../src/core/catalog';

function stubFetch(status: number, body: unknown, onUrl?: (url: string) => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    onUrl?.(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Awaited<ReturnType<typeof fetch>>;
  }) as typeof fetch;
}

describe('the bundled catalog', () => {
  it('has a unique id and symbol for every instrument', () => {
    const ids = INSTRUMENTS.map((instrument) => instrument.id);
    const symbols = INSTRUMENTS.map((instrument) => instrument.symbol);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('prices every instrument on a whole number of ticks', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.referencePriceMinor % instrument.tickSizeMinor).toBe(0);
      expect(instrument.tickSizeMinor).toBeGreaterThan(0);
      expect(instrument.lotSize).toBeGreaterThan(0);
    }
  });

  it('looks an instrument up by id and refuses an unknown one', () => {
    expect(instrumentById('coffee-green').symbol).toBe('GRN');
    expect(() => instrumentById('bitcoin')).toThrow(CatalogError);
  });

  it('filters the board by settlement currency', () => {
    expect(instrumentsInCurrency('EUR').map((instrument) => instrument.id)).toEqual(['olive-oil']);
    expect(instrumentsInCurrency('USD').length).toBe(INSTRUMENTS.length - 1);
  });

  it('fingerprints the catalog so an old recording identifies its instruments', () => {
    const first = catalogFingerprint();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(catalogFingerprint()).toBe(first);
  });
});

describe('the bundled price feed', () => {
  it('opens the same session at the same price every time', async () => {
    const feed = bundledFeed();
    const instrument = instrumentById('coffee-green');
    const first = await feed.open(instrument, 'crier_abc');
    const second = await feed.open(instrument, 'crier_abc');
    expect(second).toEqual(first);
    expect(first.priceMinor % instrument.tickSizeMinor).toBe(0);
    expect(first.source).toContain(CATALOG_AS_OF);
  });

  it('moves off the snapshot price without abandoning it', async () => {
    const feed = bundledFeed();
    const instrument = instrumentById('saffron');
    const quotes = await Promise.all(
      Array.from({ length: 40 }, (unused, index) => feed.open(instrument, `crier_session_${index}`)),
    );
    const prices = quotes.map((quote) => quote.priceMinor);
    for (const price of prices) {
      const deviationBps = Math.abs(price - instrument.referencePriceMinor) / instrument.referencePriceMinor;
      expect(deviationBps).toBeLessThan(0.12);
    }
    // Not all one price, or the floor would open every session identically.
    expect(new Set(prices).size).toBeGreaterThan(1);
  });
});

describe('the live price feed seam', () => {
  it('converts a decimal quote into a whole tick', async () => {
    const feed = liveFeed({
      baseUrl: 'https://prices.example.com/',
      apiKey: 'k',
      fetchImpl: stubFetch(200, { price: 483.7, timestamp: '2026-10-01T09:15:00Z' }),
    });
    const quote = await feed.open(instrumentById('coffee-green'), 'crier_abc');
    expect(quote.feed).toBe('live');
    // 483.70 -> 48370 minor, snapped to the 50 minor tick.
    expect(quote.priceMinor).toBe(48_350);
    expect(quote.at).toBe(Date.parse('2026-10-01T09:15:00Z'));
  });

  it('asks the provider for the instrument symbol and nothing else', async () => {
    let seen = '';
    const feed = liveFeed({
      baseUrl: 'https://prices.example.com/',
      apiKey: 'secret-key',
      fetchImpl: stubFetch(200, { price: 1 }, (url) => {
        seen = url;
      }),
    });
    await feed.open(instrumentById('coffee-green'), 'crier_abc');
    expect(seen).toBe('https://prices.example.com/quote?symbol=GRN');
  });

  it('fails loudly when the provider answers badly', async () => {
    const feed = liveFeed({ baseUrl: 'https://prices.example.com', apiKey: 'k', fetchImpl: stubFetch(503, {}) });
    await expect(feed.open(instrumentById('coffee-green'), 'crier_abc')).rejects.toThrow(/answered 503/);
  });

  it('fails loudly when the provider answers with something unusable', async () => {
    const feed = liveFeed({ baseUrl: 'https://prices.example.com', apiKey: 'k', fetchImpl: stubFetch(200, { price: 'stale' }) });
    await expect(feed.open(instrumentById('coffee-green'), 'crier_abc')).rejects.toThrow(/no usable price/);
  });

  it('stays bundled unless both the url and the key are configured', () => {
    expect(feedFromEnvironment({}).mode).toBe('bundled');
    expect(feedFromEnvironment({ CATALOG_FEED_URL: 'https://prices.example.com' }).mode).toBe('bundled');
    expect(feedFromEnvironment({ CATALOG_FEED_KEY: 'k' }).mode).toBe('bundled');
    expect(feedFromEnvironment({ CATALOG_FEED_URL: 'https://prices.example.com', CATALOG_FEED_KEY: 'k' }).mode).toBe('live');
  });
});
