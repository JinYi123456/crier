import type { SessionSnapshot } from '../../core/world';
import { cash } from './format';

/**
 * The clerk's sheet.
 *
 * Every hand that is up, stacked by price, deepest first, with the names of the houses behind each
 * level. The board is the one thing in the room that is not a summary: it is the resting orders
 * themselves, and a trade can only be booked against a line on this sheet.
 */

type Level = { priceMinor: number; qty: number; parties: string[] };

function levels(resting: SessionSnapshot['markets'][number]['bids']): Level[] {
  const byPrice = new Map<number, Level>();
  for (const order of resting) {
    const level = byPrice.get(order.priceMinor) ?? { priceMinor: order.priceMinor, qty: 0, parties: [] };
    level.qty += order.remaining;
    if (!level.parties.includes(order.party)) level.parties.push(order.party);
    byPrice.set(order.priceMinor, level);
  }
  return [...byPrice.values()];
}

function house(party: string): string {
  const parts = party.split('-');
  const name = parts[1] ?? party;
  return name.charAt(0).toUpperCase() + name.slice(1, 5);
}

export default function DepthBoard({
  market,
  currency,
  name,
  symbol,
  lot,
  selectedParty,
  onSelectParty,
}: {
  market: SessionSnapshot['markets'][number];
  currency: SessionSnapshot['currency'];
  name: string;
  symbol: string;
  lot: string;
  selectedParty: string | null;
  onSelectParty: (party: string) => void;
}): React.ReactElement {
  const bids = levels(market.bids).sort((a, b) => b.priceMinor - a.priceMinor);
  const asks = levels(market.asks).sort((a, b) => a.priceMinor - b.priceMinor);
  const deepest = Math.max(1, ...bids.map((level) => level.qty), ...asks.map((level) => level.qty));
  const spread = market.best.spreadMinor;
  const lastAgainstOpen = market.lastPrintMinor === null ? null : market.lastPrintMinor - market.openingMinor;

  const row = (level: Level, side: 'buy' | 'sell'): React.ReactElement => {
    const width = Math.max(4, Math.round((level.qty / deepest) * 100));
    const colour = side === 'buy' ? '#3fbf9a' : '#e2683f';
    return (
      <div key={`${side}-${level.priceMinor}`} className="relative flex h-[19px] items-center gap-2 px-2">
        <div
          className="absolute inset-y-[2px] left-2 rounded-sm opacity-25"
          style={{ width: `${width}%`, background: colour }}
          aria-hidden="true"
        />
        <span className="relative z-10 w-20 shrink-0 font-mono text-[12px] tnum" style={{ color: colour }}>
          {cash(level.priceMinor, currency)}
        </span>
        <span className="relative z-10 w-8 shrink-0 text-right font-mono text-[12px] text-white/70 tnum">{level.qty}</span>
        <span className="relative z-10 flex min-w-0 flex-wrap gap-1">
          {level.parties.map((party) => (
            <button
              key={party}
              type="button"
              onClick={() => onSelectParty(party)}
              className={`rounded px-1 font-mono text-[9.5px] uppercase tracking-wide transition ${
                selectedParty === party ? 'bg-brass text-ink' : 'bg-white/8 text-white/45 hover:bg-white/16 hover:text-white/75'
              }`}
              title={party}
            >
              {house(party)}
            </button>
          ))}
        </span>
      </div>
    );
  };

  return (
    <section className="brass-edge overflow-hidden rounded-lg bg-felt/55">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-white/10 px-4 py-3">
        <h3 className="font-display text-[17px] text-paper">{name}</h3>
        <span className="font-mono text-[11px] tracking-[0.18em] text-brass/80">{symbol}</span>
        <span className="ml-auto text-right font-mono text-[11px] text-white/40">{lot}</span>
      </header>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 border-b border-white/10 px-4 py-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Last print</div>
          <div className="font-mono text-[26px] leading-tight text-paper tnum">
            {market.lastPrintMinor === null ? '—' : cash(market.lastPrintMinor, currency)}
          </div>
          <div className={`font-mono text-[11px] tnum ${lastAgainstOpen === null ? 'text-white/35' : lastAgainstOpen >= 0 ? 'text-buy' : 'text-sell'}`}>
            {lastAgainstOpen === null
              ? `open ${cash(market.openingMinor, currency)}`
              : `${lastAgainstOpen >= 0 ? '+' : ''}${cash(lastAgainstOpen, currency)} since the open`}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-[11px]">
          <div>
            <dt className="text-white/40">Best bid</dt>
            <dd className="m-0 font-mono text-[15px] text-buy tnum">{market.best.bidMinor === null ? '—' : cash(market.best.bidMinor, currency)}</dd>
          </div>
          <div>
            <dt className="text-white/40">Best offer</dt>
            <dd className="m-0 font-mono text-[15px] text-sell tnum">{market.best.askMinor === null ? '—' : cash(market.best.askMinor, currency)}</dd>
          </div>
          <div>
            <dt className="text-white/40">Spread</dt>
            <dd className="m-0 font-mono text-[15px] text-paper tnum">{spread === null ? '—' : cash(spread, currency)}</dd>
          </div>
        </dl>
      </div>

      <div className="grid gap-0 md:grid-cols-2">
        <div className="border-r border-white/10 py-2">
          <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-sell/70">Offers, cheapest first</div>
          {asks.length === 0 ? <p className="px-4 text-[12px] text-white/30">nobody is offering</p> : asks.slice(0, 8).map((level) => row(level, 'sell'))}
        </div>
        <div className="py-2">
          <div className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-buy/70">Bids, highest first</div>
          {bids.length === 0 ? <p className="px-4 text-[12px] text-white/30">nobody is bidding</p> : bids.slice(0, 8).map((level) => row(level, 'buy'))}
        </div>
      </div>
    </section>
  );
}
