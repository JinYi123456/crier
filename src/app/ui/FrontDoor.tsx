'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FloorPointer } from '../../server/floor';
import { floorHref } from './pointer';
import PitPlan from './PitPlan';

/**
 * The doors of the exchange.
 *
 * Everything a floor needs is a seed and a shape, so this form is short on purpose: a seed you can
 * type, a handful of instruments, and two dials. The seed is the interesting part - two people who
 * enter the same seed watch the same negotiation, and a recording of it can be checked line by line
 * by somebody who was not here.
 *
 * The plan of the pit lives in this component rather than beside it because it is drawn from the same
 * state: the room on the right is the room the button on the left will open, to the house.
 */

export interface InstrumentOption {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly lot: string;
}

export default function FrontDoor({ instruments }: { instruments: readonly InstrumentOption[] }): React.ReactElement {
  const router = useRouter();
  const [seed, setSeed] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [sandbox, setSandbox] = useState(false);
  const [agents, setAgents] = useState(4);
  const [ticks, setTicks] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pits = (picked.length > 0 ? instruments.filter((instrument) => picked.includes(instrument.id)) : instruments).map(
    (instrument) => ({ name: instrument.name, symbol: instrument.symbol }),
  );

  function toggle(id: string): void {
    setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  async function open(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/floor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(seed.trim().length > 0 ? { seed: seed.trim() } : {}),
          instruments: picked,
          gateway: sandbox ? 'sandbox' : 'sim',
          agentsPerSide: agents,
          maxTicks: ticks,
        }),
      });
      const body = (await response.json()) as { floor?: string; error?: string; pointer?: FloorPointer };
      if (!response.ok || typeof body.floor !== 'string') {
        setError(body.error ?? 'the floor would not open');
        setBusy(false);
        return;
      }
      // The pointer goes in the URL, so the room this seed opened can be rebuilt by whichever machine
      // answers next - a reload, a link sent to a friend, or a serverless platform with no memory.
      router.push(body.pointer === undefined ? `/floor/${encodeURIComponent(body.floor)}` : floorHref(body.floor, body.pointer, 0));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-brass/80">Commodities, crafts, small goods</p>
        <h1 className="mt-3 font-display text-[34px] leading-[1.06] text-balance text-paper sm:text-[42px] xl:text-[54px]">
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

        <section className="brass-edge mt-7 rounded-lg bg-felt/70 p-5">
          <h2 className="font-display text-[19px] tracking-[0.08em] text-paper">Open a floor</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-white/55">
            Leave the seed blank and you get a fresh market. Type one you have seen before and you land in the same pit, at
            the same prices, with the same houses.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(200px,1fr)_minmax(0,2fr)]">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-white/45">Seed</span>
              <input
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                placeholder="e.g. thursday-lane"
                className="mt-1 w-full rounded border border-white/15 bg-ink/70 px-3 py-2 font-mono text-[14px] text-paper outline-none placeholder:text-white/25 focus:border-brass/60"
              />
            </label>

            <div>
              <span className="text-[11px] uppercase tracking-[0.18em] text-white/45">Instruments - leave none picked for the full board</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {instruments.map((instrument) => {
                  const on = picked.includes(instrument.id);
                  return (
                    <button
                      key={instrument.id}
                      type="button"
                      title={instrument.lot}
                      onClick={() => toggle(instrument.id)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-[12px] transition ${
                        on ? 'border-brass bg-brass/20 text-brass' : 'border-white/15 text-white/60 hover:border-white/35 hover:text-white/80'
                      }`}
                    >
                      {instrument.name} <span className="font-mono opacity-70">{instrument.symbol}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-6">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-white/45">Houses per side</span>
              <input
                type="number"
                min={2}
                max={8}
                value={agents}
                onChange={(event) => setAgents(Math.max(2, Math.min(8, Number(event.target.value) || 2)))}
                className="mt-1 w-24 rounded border border-white/15 bg-ink/70 px-3 py-2 font-mono text-[14px] text-paper outline-none focus:border-brass/60"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-white/45">Rounds before the bell</span>
              <input
                type="number"
                min={4}
                max={40}
                value={ticks}
                onChange={(event) => setTicks(Math.max(4, Math.min(40, Number(event.target.value) || 4)))}
                className="mt-1 w-24 rounded border border-white/15 bg-ink/70 px-3 py-2 font-mono text-[14px] text-paper outline-none focus:border-brass/60"
              />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-white/70">
              <input type="checkbox" checked={sandbox} onChange={(event) => setSandbox(event.target.checked)} className="h-4 w-4 accent-brass" />
              settle on the real processor
              <span className="text-white/35">(only a machine that has been handed PayPal credentials is allowed to)</span>
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => void open()}
              className="ml-auto rounded bg-brass px-5 py-2 font-display text-[15px] tracking-[0.06em] text-ink transition hover:bg-[#eab94f] disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Take the floor'}
            </button>
          </div>

          {error.length > 0 && <p className="mt-3 text-[13px] text-alarm">{error}</p>}
        </section>
      </div>

      <div className="brass-edge self-center rounded-xl bg-felt/45 p-4">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-white/35">Plan of the floor</p>
        <PitPlan agents={agents} ticks={ticks} pits={pits} seed={seed} sandbox={sandbox} />
      </div>
    </div>
  );
}
