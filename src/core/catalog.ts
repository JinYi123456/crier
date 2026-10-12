import { derivedId, hashOf, sha256Hex } from './canonical';
import type { CurrencyCode } from './money';

/**
 * What the floor actually trades.
 *
 * A pit needs a fixed set of standardised lots: the whole point of open outcry is that two
 * strangers can shout about the same thing and mean the same thing. These instruments are
 * bundled into the app so a session is reproducible offline, and the reference prices are a
 * snapshot, not a claim about today's market.
 *
 * A live feed can replace the bundled one behind the same `PriceFeed` interface. Nothing else
 * in the engine is allowed to know where a price came from.
 */

export type InstrumentCategory = 'produce' | 'craft' | 'textile' | 'pantry' | 'metal' | 'print';

export interface Instrument {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly category: InstrumentCategory;
  /** One lot of this, phrased the way a crier would say it out loud. */
  readonly lot: string;
  /** Smallest quantity a call may be for. */
  readonly lotSize: number;
  readonly currency: CurrencyCode;
  /** Calls off the board move in whole ticks of this. */
  readonly tickSizeMinor: number;
  /** The bundled snapshot price the floor opens near, in minor units. */
  readonly referencePriceMinor: number;
  readonly blurb: string;
}

/** When this snapshot was taken. Shown on the pit screen so nobody mistakes it for live data. */
export const CATALOG_AS_OF = '2026-10-01T09:15:00Z';

export const INSTRUMENTS: readonly Instrument[] = [
  {
    id: 'coffee-green',
    symbol: 'GRN',
    name: 'Single-origin green coffee',
    category: 'produce',
    lot: 'a 60 kg jute bag of washed arabica',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 50,
    referencePriceMinor: 48_000,
    blurb: 'Graded, rested, sold by the bag. Cup quality decided by the buyer on arrival.',
  },
  {
    id: 'cacao-fine',
    symbol: 'CAC',
    name: 'Fine-flavour cacao',
    category: 'produce',
    lot: 'a 25 kg sack of fermented, sun-dried beans',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 25,
    referencePriceMinor: 21_500,
    blurb: 'Moisture under 7.5 per cent, mould count on the certificate.',
  },
  {
    id: 'wool-fleece',
    symbol: 'WOL',
    name: 'Undyed merino fleece',
    category: 'textile',
    lot: 'a bale of 120 kg skirting',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 100,
    referencePriceMinor: 96_000,
    blurb: 'Micron tested at sale. The bale is the unit; nobody splits a staple.',
  },
  {
    id: 'ceramic-mug',
    symbol: 'CRG',
    name: 'Stoneware mugs',
    category: 'craft',
    lot: 'a crate of 36 thrown mugs',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 25,
    referencePriceMinor: 12_600,
    blurb: 'Kiln-packed as thrown. Glaze variation is expected, breakage is not.',
  },
  {
    id: 'olive-oil',
    symbol: 'OIL',
    name: 'Extra virgin olive oil',
    category: 'pantry',
    lot: 'a case of 12 x 500 ml tins',
    lotSize: 1,
    currency: 'EUR',
    tickSizeMinor: 10,
    referencePriceMinor: 18_900,
    blurb: 'Current harvest, acidity under 0.3%, dated on the tin.',
  },
  {
    id: 'honey-comb',
    symbol: 'HNY',
    name: 'Raw comb honey',
    category: 'pantry',
    lot: 'a tray of 48 cut-comb jars',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 20,
    referencePriceMinor: 9_400,
    blurb: 'Unheated, unfiltered, crystallisation is the point.',
  },
  {
    id: 'saffron',
    symbol: 'SAF',
    name: 'Saffron threads',
    category: 'pantry',
    lot: 'a sealed tin of 100 g grade I',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 5,
    referencePriceMinor: 61_000,
    blurb: 'Colour strength above 270. The most valuable thing on the floor per gram.',
  },
  {
    id: 'copper-sheet',
    symbol: 'CPR',
    name: 'Copper sheet',
    category: 'metal',
    lot: 'a pallet of 8 rolled sheets',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 200,
    referencePriceMinor: 22_400,
    blurb: 'Milled gauge, weight ticket attached. Moves with the metal tape.',
  },
  {
    id: 'photo-print',
    symbol: 'PRT',
    name: 'Vintage gelatin silver prints',
    category: 'print',
    lot: 'a portfolio of 5 stamped prints',
    lotSize: 1,
    currency: 'USD',
    tickSizeMinor: 500,
    referencePriceMinor: 155_000,
    blurb: 'Edition-stamped on the reverse, provenance in the folder.',
  },
];

export function instrumentById(id: string): Instrument {
  const found = INSTRUMENTS.find((instrument) => instrument.id === id);
  if (!found) throw new CatalogError(`no instrument ${id} on the floor`);
  return found;
}

export function instrumentsInCurrency(currency: CurrencyCode): Instrument[] {
  return INSTRUMENTS.filter((instrument) => instrument.currency === currency);
}

/**
 * A short commitment that changes whenever the catalog changes. It goes into `market.open` so
 * an old recording can be identified as being about a different set of instruments.
 */
export function catalogFingerprint(): string {
  return hashOf(INSTRUMENTS.map((instrument) => [instrument.id, instrument.currency, instrument.tickSizeMinor, instrument.referencePriceMinor])).slice(0, 16);
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

export interface PriceQuote {
  readonly instrument: string;
  readonly priceMinor: number;
  readonly at: number;
  readonly feed: 'bundled' | 'live';
  readonly source: string;
}

export interface PriceFeed {
  readonly mode: 'bundled' | 'live';
  /** Resolves the session's opening price for an instrument. Async because a live feed is a network call. */
  open(instrument: Instrument, session: string): Promise<PriceQuote>;
}

/**
 * The bundled feed opens a session near the snapshot price, off by a deterministic drift keyed
 * on the session and the instrument. Same session id, same opening print, forever.
 */
export function bundledFeed(): PriceFeed {
  return {
    mode: 'bundled',
    open: async (instrument, session) => {
      const digest = sha256Hex(derivedId('drift', session, instrument.id));
      const roll = parseInt(digest.slice(0, 6), 16) % 2_000;
      const bps = roll - 1_000;
      const raw = Math.round((instrument.referencePriceMinor * (10_000 + bps)) / 10_000);
      const tick = instrument.tickSizeMinor;
      const priceMinor = Math.max(tick, Math.round(raw / tick) * tick);
      return {
        instrument: instrument.id,
        priceMinor,
        at: 0,
        feed: 'bundled',
        source: `snapshot ${CATALOG_AS_OF}`,
      };
    },
  };
}

export interface LiveFeedConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The seam for a live price provider. It is deliberately unconfigured in the engine: a session
 * runs entirely on the bundled snapshot unless a caller passes a base URL and a key, which means
 * the app has no dependency on somebody else's uptime to be demonstrable.
 */
export function liveFeed(config: LiveFeedConfig): PriceFeed {
  return {
    mode: 'live',
    async open(instrument: Instrument): Promise<PriceQuote> {
      const url = `${config.baseUrl.replace(/\/+$/, '')}/quote?symbol=${encodeURIComponent(instrument.symbol)}`;
      const response = await (config.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${config.apiKey}` } });
      if (!response.ok) throw new CatalogError(`the price feed answered ${response.status} for ${instrument.symbol}`);
      const body = (await response.json()) as { price?: number; timestamp?: string };
      if (typeof body.price !== 'number' || !Number.isFinite(body.price)) {
        throw new CatalogError(`the price feed sent no usable price for ${instrument.symbol}`);
      }
      // A live feed is expected to speak decimal units; convert once, at the boundary.
      const minor = Math.round(body.price * 100);
      const tick = instrument.tickSizeMinor;
      return {
        instrument: instrument.id,
        priceMinor: Math.max(tick, Math.round(minor / tick) * tick),
        at: body.timestamp ? Date.parse(body.timestamp) : 0,
        feed: 'live',
        source: config.baseUrl,
      };
    },
  };
}

export function feedFromEnvironment(env: Readonly<Record<string, string | undefined>>): PriceFeed {
  const baseUrl = env.CATALOG_FEED_URL;
  const apiKey = env.CATALOG_FEED_KEY;
  if (baseUrl && apiKey) return liveFeed({ baseUrl, apiKey });
  return bundledFeed();
}
