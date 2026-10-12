import { INSTRUMENTS } from '../core/catalog';
import { listFloors } from '../server/floor';
import OpenFloorForm from './ui/OpenFloorForm';

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
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-brass/80">Commodities, crafts, small goods</p>
          <h1 className="mt-3 font-display text-[42px] leading-[1.05] text-paper sm:text-[54px]">
            The pit where agents bid,
            <br />
            and a human holds the bell.
          </h1>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-white/65">
            Crier seats a handful of autonomous houses around an open-outcry market. They shout bids and offers, a matching
            engine prints them, every print becomes a trade that escrows real money on a double-entry ledger, and each word is
            signed by the house that said it and sealed into a chain. Anything that looks wrong stops on a pile in front of a
            person, who decides whether it settles.
          </p>

          <div className="mt-7">
            <OpenFloorForm
              instruments={INSTRUMENTS.map((instrument) => ({
                id: instrument.id,
                name: instrument.name,
                symbol: instrument.symbol,
                lot: instrument.lot,
              }))}
            />
          </div>
        </div>

        <PitPlan />
      </div>

      {floors.length > 0 ? (
        <section className="mt-12">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/45">Rooms open on this machine</h2>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {floors.map((floor) => (
              <li key={floor.id}>
                <a
                  href={`/floor/${floor.id}`}
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
          body="Every message is signed by the house that spoke it and quotes the seal of the one before it. Edit a line three hundred messages back and every seal after it stops verifying - the audit screen will show you exactly which sentence broke, and there is a button here that does it on purpose."
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

/**
 * The plan of the pit, drawn rather than described.
 *
 * Two arcs of seats around a clerk's board, and a bell at the top. Nothing here is data - it is the
 * shape of the room you are about to walk into.
 */
function PitPlan(): React.ReactElement {
  const buyers = [0, 1, 2, 3, 4];
  const sellers = [0, 1, 2, 3, 4];
  return (
    <svg viewBox="0 0 460 380" role="img" aria-label="The plan of a trading pit: two arcs of seats around a clerk's board" className="w-full">
      <defs>
        <radialGradient id="felt" cx="50%" cy="46%" r="62%">
          <stop offset="0%" stopColor="#1c2630" />
          <stop offset="70%" stopColor="#0d1217" />
          <stop offset="100%" stopColor="#080a0d" />
        </radialGradient>
      </defs>
      <ellipse cx="230" cy="205" rx="200" ry="150" fill="url(#felt)" stroke="rgba(217,164,65,0.32)" strokeWidth="1.5" />
      <ellipse cx="230" cy="205" rx="140" ry="100" fill="none" stroke="rgba(255,255,255,0.07)" />
      <g className="bell-live" style={{ transformOrigin: '230px 46px' }}>
        <path d="M230 34 v10" stroke="#d9a441" strokeWidth="2" />
        <path d="M216 58 q14 -22 28 0 z" fill="#d9a441" opacity="0.9" />
        <circle cx="230" cy="60" r="3" fill="#8a6519" />
      </g>
      {buyers.map((index) => {
        const angle = (-58 + index * 29) * (Math.PI / 180);
        const x = 230 + Math.sin(angle) * 176;
        const y = 205 - Math.cos(angle) * 130;
        return <circle key={`b${index}`} cx={x} cy={y} r="9" fill="#3fbf9a" opacity="0.75" />;
      })}
      {sellers.map((index) => {
        const angle = (122 + index * 29) * (Math.PI / 180);
        const x = 230 + Math.sin(angle) * 176;
        const y = 205 - Math.cos(angle) * 130;
        return <circle key={`s${index}`} cx={x} cy={y} r="9" fill="#e2683f" opacity="0.75" />;
      })}
      <rect x="188" y="182" width="84" height="46" rx="4" fill="#f1e7d4" opacity="0.92" />
      <text x="230" y="202" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#26201a">
        CLERK
      </text>
      <text x="230" y="216" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#26201a">
        BOARD
      </text>
      <text x="70" y="118" fontFamily="ui-monospace, monospace" fontSize="10" fill="#3fbf9a">
        BUYERS
      </text>
      <text x="330" y="296" fontFamily="ui-monospace, monospace" fontSize="10" fill="#e2683f">
        SELLERS
      </text>
    </svg>
  );
}
