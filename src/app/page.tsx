import { INSTRUMENTS } from '../core/catalog';
import { DEFAULT_CURRENCY, DEFAULT_INSTRUMENTS } from '../core/world';
import { listFloors } from '../server/floor';
import { floorHref } from './ui/pointer';
import FrontDoor from './ui/FrontDoor';

export const dynamic = 'force-dynamic';

/**
 * The doors.
 *
 * A first visitor should see a market, not a manual: the plan of a pit, a seed box, and the rooms
 * already running. The explanation is underneath, and it is short because the floor explains itself
 * better than this page can.
 */
export default function Home(): React.ReactElement {
  const floors = listFloors();

  return (
    <div className="pt-10">
      <FrontDoor
        currency={DEFAULT_CURRENCY}
        defaults={DEFAULT_INSTRUMENTS}
        instruments={INSTRUMENTS.map((instrument) => ({
          id: instrument.id,
          name: instrument.name,
          symbol: instrument.symbol,
          lot: instrument.lot,
          currency: instrument.currency,
        }))}
      />

      {floors.length > 0 ? (
        <section className="mt-12">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/45">Rooms open on this machine</h2>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {floors.map((floor) => (
              <li key={floor.id}>
                <a
                  href={floorHref(floor.id, floor.pointer, floor.tick)}
                  className="brass-edge block rounded bg-felt/60 p-4 no-underline transition hover:bg-felt-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-[17px] text-paper">{floor.seed}</span>
                    <span className={`rounded px-2 py-0.5 font-mono text-[10px] ${floor.closed ? 'bg-white/10 text-white/50' : 'bg-brass/20 text-brass'}`}>
                      {floor.closed ? 'CLOSED' : `ROUND ${floor.tick}/${floor.maxTicks}`}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-white/45">{floor.id}</div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-white/60 tnum">
                    <span>{floor.trades} trades</span>
                    <span>{floor.held} waiting on a person</span>
                    <span>{floor.messages} seals</span>
                    <span className="font-mono">{floor.gateway}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
        <Column
          kicker="Money that balances"
          body="Each trade is booked, not described: escrow, what is owed to the buyer, what is owed to the seller, the platform's fee. Every journal entry has two sides and the machine checks that they are equal before it lets a settlement move."
        />
        <Column
          kicker="A log that confesses"
          body="Every message is signed by the house that spoke it and quotes the seal of the one before it. Edit a line three hundred messages back and every seal after it stops verifying - the audit screen will show you exactly which sentence broke, and there is a button in the pit that does it on purpose."
        />
        <Column
          kicker="A queue with a person in it"
          body="Five rules catch what the engine should not settle alone: an amount over the auto-settle line, a price far from the board, a pairing that has never traded, a seller carrying too much of the session, a house with no reputation. A processor still waiting for its buyer joins the same pile, because both are a settlement waiting on a human."
        />
      </section>
    </div>
  );
}

function Column({ kicker, body }: { kicker: string; body: string }): React.ReactElement {
  return (
    <article className="border-t border-white/10 pt-4">
      <h3 className="font-display text-[17px] text-brass">{kicker}</h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-white/60">{body}</p>
    </article>
  );
}
