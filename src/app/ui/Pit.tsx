'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot, SerializedTrade } from '../../core/world';
import type { Finding, SealedMessage } from '../../core/protocol';
import type { TickResult } from '../../server/floor';
import type { TradeActionKind } from './ChitStack';
import ChitStack from './ChitStack';
import DepthBoard from './DepthBoard';
import SeatRing, { type Seat } from './SeatRing';
import Tape from './Tape';
import TradeRail from './TradeRail';
import { cash, shortKey } from './format';
import { readOperatorKey, rememberOperatorKey } from './operator';
import { floorSound, thump } from './sound';
import type { InstrumentCard } from './instruments';
import type { Envelope } from './envelope';

/**
 * The room.
 *
 * One screen, one floor. The engine only moves when the bell is rung, so nothing here is on a timer
 * of its own: a round is asked for, the answer is drawn, and the sound of the room follows what the
 * houses actually did rather than playing a loop.
 */

export default function Pit({
  id,
  initial,
  instruments,
}: {
  id: string;
  initial: Envelope;
  instruments: readonly InstrumentCard[];
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(initial.snapshot);
  const [messages, setMessages] = useState<readonly SealedMessage[]>(initial.snapshot.messages);
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [sound, setSound] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const [marketIndex, setMarketIndex] = useState(0);
  const [party, setParty] = useState<string | null>(null);
  const [inspect, setInspect] = useState<SealedMessage | null>(null);
  const [tamper, setTamper] = useState<{ seq: number; total: number; first: readonly string[] } | null>(null);
  const [printFlash, setPrintFlash] = useState(0);
  const [deskLocked, setDeskLocked] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const busyRef = useRef(false);
  const operatorKeyRef = useRef('');
  const seqRef = useRef(initial.sinceSeq);
  const printsRef = useRef(initial.snapshot.trades.length);

  const trades = snapshot.trades;
  const held = useMemo(() => trades.filter((trade) => trade.held), [trades]);
  const closed = snapshot.closed;
  const currency = snapshot.currency;
  const market = snapshot.markets[Math.min(marketIndex, snapshot.markets.length - 1)]!;
  const instrument = instruments.find((entry) => entry.id === market.instrumentId);

  const shout = useCallback((cue: 'bell' | 'print' | 'shout' | 'stamp' | 'chime') => {
    if (sound) floorSound.cue(cue);
  }, [sound]);

  // The key lives in the browser's own storage, which only exists after the page is on screen.
  useEffect(() => {
    const stored = readOperatorKey();
    operatorKeyRef.current = stored;
    setDeskLocked(initial.locked === true && stored.length === 0);
  }, [initial.locked]);

  const pull = useCallback(
    async (since: number): Promise<void> => {
      const response = await fetch(`/api/floor/${encodeURIComponent(id)}?since=${since}`, { cache: 'no-store' });
      const body = (await response.json()) as Partial<Envelope> & { error?: string };
      if (body.snapshot === undefined || body.sinceSeq === undefined) {
        setNotice({ text: body.error ?? 'the floor would not answer', bad: true });
        return;
      }
      const fresh = body.snapshot.messages;
      if (body.locked !== undefined) setDeskLocked(body.locked && operatorKeyRef.current.length === 0);
      if (fresh.length > 0) {
        setMessages((current) => (since < 0 ? fresh : [...current, ...fresh]));
        const delta: Record<string, number> = {};
        for (const message of fresh) {
          const speaker = typeof message.payload['party'] === 'string' ? (message.payload['party'] as string) : '';
          if (speaker.length > 0 && (message.type === 'floor.quote' || message.type === 'floor.accept' || message.type === 'book.order')) {
            delta[speaker] = (delta[speaker] ?? 0) + 1;
          }
        }
        if (Object.keys(delta).length > 0) setPulses((current) => ({ ...current, ...delta }));
      }
      const printed = body.snapshot.trades.length > printsRef.current;
      printsRef.current = body.snapshot.trades.length;
      seqRef.current = body.sinceSeq;
      setSnapshot(body.snapshot);
      if (printed) {
        setPrintFlash((count) => count + 1);
        shout('print');
      }
    },
    [id, shout],
  );

  const post = useCallback(
    async (payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown>; error: string }> => {
      const held = operatorKeyRef.current;
      const response = await fetch(`/api/floor/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(held.length > 0 ? { 'x-operator-token': held } : {}) },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 401) {
        // The key this browser offered did not open the desk. Forget it and ask again.
        operatorKeyRef.current = '';
        rememberOperatorKey('');
        setDeskLocked(true);
      }
      const error = typeof body.error === 'string' ? body.error : response.ok ? '' : 'the floor refused';
      return { ok: response.ok && error === '', body, error };
    },
    [id],
  );

  const handOverKey = useCallback((): void => {
    const given = keyDraft.trim();
    if (given.length === 0) return;
    operatorKeyRef.current = given;
    rememberOperatorKey(given);
    setKeyDraft('');
    setDeskLocked(false);
    setNotice({ text: 'the desk has the key: from here the floor acts on what you sign', bad: false });
  }, [keyDraft]);

  const command = useCallback(
    async (action: 'step' | 'run' | 'close'): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const answer = await post({ action });
      if (!answer.ok) setNotice({ text: answer.error, bad: true });
      else {
        if (action === 'step') {
          const result = answer.body['result'] as TickResult | undefined;
          if (result) {
            shout(result.prints > 0 ? 'print' : 'shout');
            floorSound.setMurmur(Math.min(1, result.shouts / 10));
            if (result.held > 0) setNotice({ text: `${result.held} settlement(s) stopped and went onto the pile`, bad: false });
          }
        }
        if (action === 'run') shout('bell');
        if (action === 'close') {
          shout('bell');
          setAuto(false);
          floorSound.setMurmur(0);
        }
        await pull(seqRef.current);
      }
      busyRef.current = false;
      setBusy(false);
    },
    [post, pull, shout],
  );

  const decide = useCallback(
    async (action: TradeActionKind, tradeId: string, note?: string, amountMinor?: number): Promise<string | null> => {
      setBusy(true);
      const answer = await post({ action: 'trade', tradeAction: action, tradeId, ...(note ? { note } : {}), ...(amountMinor ? { amountMinor } : {}) });
      if (!answer.ok) {
        setNotice({ text: answer.error, bad: true });
        setBusy(false);
        return answer.error;
      }
      shout(action === 'veto' ? 'stamp' : action === 'release' ? 'print' : 'chime');
      if (action === 'release' || action === 'veto') {
        const trade = answer.body['trade'] as SerializedTrade | undefined;
        setNotice({
          text: trade ? `${trade.id.slice(-8)} ${trade.phase === 'voided' ? 'refused and unwound' : `settled to ${trade.phase}`}` : 'decision recorded',
          bad: false,
        });
      }
      await pull(seqRef.current);
      setBusy(false);
      return null;
    },
    [post, pull, shout],
  );

  const forge = useCallback(
    async (seq: number, field: string): Promise<void> => {
      const answer = await post({ action: 'tamper', seq, field });
      if (!answer.ok) {
        setNotice({ text: answer.error, bad: true });
        return;
      }
      const result = answer.body['result'] as { total: number; first: readonly string[] };
      setTamper({ seq, total: result.total, first: result.first });
      shout('stamp');
      thump([12, 30, 12]);
    },
    [post, shout],
  );

  // A live room: the bell rings itself until the floor closes or a person takes over.
  useEffect(() => {
    if (!auto || closed) return;
    const timer = setInterval(() => void command('step'), 1_100);
    return () => clearInterval(timer);
  }, [auto, closed, command]);

  useEffect(() => {
    if (!sound) floorSound.setMurmur(0);
  }, [sound]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const seats: Seat[] = snapshot.participants
    .filter((participant) => participant.instrument === market.instrumentId)
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      role: participant.role,
      pressure: participant.pressure,
      withdrawn: participant.withdrawn,
      remaining:
        participant.role === 'buy'
          ? participant.budgetMinor === 0
            ? 0
            : (participant.budgetMinor - participant.spentMinor) / participant.budgetMinor
          : participant.inventory === 0
            ? 0
            : (participant.inventory - participant.soldQty) / participant.inventory,
      filled: participant.fillsAsMaker + participant.fillsAsTaker,
      resting:
        participant.role === 'buy'
          ? market.bids.filter((order) => order.party === participant.id).map((order) => ({ priceMinor: order.priceMinor, qty: order.remaining }))
          : market.asks.filter((order) => order.party === participant.id).map((order) => ({ priceMinor: order.priceMinor, qty: order.remaining })),
    }));

  const dossier = snapshot.participants.find((participant) => participant.id === party) ?? null;
  const findings = snapshot.verification.findings;
  const gross = snapshot.summary.grossMinor;

  return (
    <div className="pt-5">
      <BellBar
        id={id}
        seed={snapshot.seed}
        gateway={snapshot.gateway}
        tick={snapshot.tick}
        maxTicks={snapshot.maxTicks}
        closed={closed}
        busy={busy}
        auto={auto}
        sound={sound}
        trades={trades.length}
        held={held.length}
        gross={gross}
        fee={snapshot.summary.feeMinor}
        currency={currency}
        headHash={snapshot.headHash}
        verified={snapshot.verification.ok}
        findings={findings}
        messages={messages.length}
        onStep={() => void command('step')}
        onRun={() => void command('run')}
        onClose={() => void command('close')}
        onAuto={() => {
          setAuto((current) => !current);
          if (!auto) setNotice({ text: 'the bell is ringing itself - press it again to stop', bad: false });
        }}
        onSound={async () => {
          if (sound) {
            setSound(false);
            floorSound.setMurmur(0);
            return;
          }
          await floorSound.enable();
          setSound(true);
          floorSound.cue('bell');
        }}
      />

      {notice !== null && (
        <p className={`mt-3 rounded px-3 py-2 text-[12.5px] ${notice.bad ? 'bg-alarm/15 text-alarm' : 'bg-brass/12 text-brass'}`}>{notice.text}</p>
      )}

      {deskLocked && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handOverKey();
          }}
          className="mt-3 flex flex-wrap items-center gap-2 rounded border border-brass/30 bg-brass/8 px-3 py-2"
        >
          <label htmlFor="operator-key" className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass/85">
            operator key
          </label>
          <input
            id="operator-key"
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            autoComplete="off"
            placeholder="this desk settles money on a named person's signature"
            className="min-w-0 flex-1 rounded border border-white/15 bg-ink/60 px-2 py-1 font-mono text-[12px] text-white/80 outline-none focus:border-brass"
          />
          <button
            type="submit"
            className="rounded border border-brass/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-brass transition hover:bg-brass/10"
          >
            hand it over
          </button>
        </form>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,1fr)]">
        <div className="space-y-4">
          {snapshot.markets.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {snapshot.markets.map((entry, index) => {
                const meta = instruments.find((candidate) => candidate.id === entry.instrumentId);
                return (
                  <button
                    key={entry.instrumentId}
                    type="button"
                    onClick={() => {
                      setMarketIndex(index);
                      setParty(null);
                    }}
                    className={`rounded-full border px-3 py-1 text-[12px] transition ${
                      index === marketIndex ? 'border-brass bg-brass/18 text-brass' : 'border-white/15 text-white/55 hover:border-white/35'
                    }`}
                  >
                    {meta?.name ?? entry.instrumentId}
                  </button>
                );
              })}
            </div>
          )}

          <div className="pit-floor brass-edge rounded-xl p-2">
            <SeatRing
              seats={seats}
              board={market}
              currency={currency}
              pulses={pulses}
              selectedId={party}
              onSelect={(next) => setParty((current) => (current === next ? null : next))}
              lastPrintFlash={printFlash}
            />
          </div>

          {dossier !== null && (
            <Dossier participant={dossier} currency={currency} onClose={() => setParty(null)} />
          )}

          <DepthBoard
            market={market}
            currency={currency}
            name={instrument?.name ?? market.instrumentId}
            symbol={instrument?.symbol ?? '—'}
            lot={instrument?.lot ?? ''}
            selectedParty={party}
            onSelectParty={(next) => setParty((current) => (current === next ? null : next))}
          />
        </div>

        <div className="space-y-4">
          <ChitStack trades={held} currency={currency} policy={snapshot.policy} onAction={decide} busy={busy} />
          <TradeRail trades={trades} currency={currency} onAction={decide} busy={busy} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="max-h-[520px]">
          <Tape messages={messages} findings={findings} currency={currency} selectedSeq={inspect?.seq ?? null} onSelect={setInspect} />
        </div>
        <Inspector message={inspect} currency={currency} snapshot={snapshot} tamper={tamper} onForge={forge} onClose={() => setInspect(null)} />
      </div>

      <footer className="mt-6 border-t border-white/10 pt-4 font-mono text-[11px] text-white/35">
        session {id} · catalogue {snapshot.catalog} · opened at {new Date(snapshot.startAt).toISOString()} · {messages.length} sealed lines on this
        screen · last seal {shortKey(snapshot.headHash)}
      </footer>
    </div>
  );
}

function BellBar({
  id,
  seed,
  gateway,
  tick,
  maxTicks,
  closed,
  busy,
  auto,
  sound,
  trades,
  held,
  gross,
  fee,
  currency,
  headHash,
  verified,
  findings,
  messages,
  onStep,
  onRun,
  onClose,
  onAuto,
  onSound,
}: {
  id: string;
  seed: string;
  gateway: string;
  tick: number;
  maxTicks: number;
  closed: boolean;
  busy: boolean;
  auto: boolean;
  sound: boolean;
  trades: number;
  held: number;
  gross: number;
  fee: number;
  currency: SessionSnapshot['currency'];
  headHash: string;
  verified: boolean;
  findings: readonly Finding[];
  messages: number;
  onStep: () => void;
  onRun: () => void;
  onClose: () => void;
  onAuto: () => void;
  onSound: () => void;
}): React.ReactElement {
  return (
    <section className="brass-edge rounded-lg bg-felt/70 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 30" width="20" height="24" className={auto && !closed ? 'bell-live' : ''} aria-hidden="true">
            <path d="M12 2 v4" stroke="#d9a441" strokeWidth="1.6" />
            <path d="M4 22 q0 -14 8 -16 q8 2 8 16 z" fill={closed ? '#5a5140' : '#d9a441'} />
            <circle cx="12" cy="24" r="2.2" fill="#8a6519" />
          </svg>
          <div>
            <div className="font-display text-[19px] leading-none text-paper">{seed}</div>
            <div className="mt-1 font-mono text-[10.5px] text-white/40">{id}</div>
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-[11px]">
          <Stat label="round" value={`${tick}/${maxTicks}`} />
          <Stat label="trades" value={String(trades)} />
          <Stat label="waiting on a person" value={String(held)} tone={held > 0 ? 'flag' : undefined} />
          <Stat label="across" value={cash(gross, currency)} />
          <Stat label="fee" value={cash(fee, currency)} />
          <Stat label="processor" value={gateway} />
        </dl>

        <div
          className={`ml-auto flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[11px] ${
            verified ? 'bg-buy/15 text-buy' : 'bg-alarm/20 text-alarm'
          }`}
          title={verified ? 'every seal on the tape lines up with the one before it' : findings.map((finding) => finding.detail).join('\n')}
        >
          {verified ? 'tape verifies' : `${findings.length} fault(s)`}
          <span className="text-white/35">{shortKey(headHash)}</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || closed}
            onClick={onStep}
            className="rounded bg-brass px-4 py-2 font-display text-[14px] text-ink transition hover:bg-[#eab94f] disabled:opacity-35"
          >
            Ring the bell
          </button>
          <button
            type="button"
            disabled={busy || closed}
            onClick={onRun}
            className="rounded border border-brass/55 px-3 py-2 font-mono text-[11.5px] uppercase tracking-[0.1em] text-brass transition hover:bg-brass/15 disabled:opacity-35"
          >
            run to the close
          </button>
          <button
            type="button"
            disabled={busy || closed}
            onClick={onAuto}
            className={`rounded border px-3 py-2 font-mono text-[11.5px] uppercase tracking-[0.1em] transition disabled:opacity-35 ${
              auto ? 'border-brass bg-brass/20 text-brass' : 'border-white/20 text-white/60 hover:border-white/40'
            }`}
          >
            {auto ? 'ringing' : 'live'}
          </button>
          <button
            type="button"
            disabled={busy || closed}
            onClick={onClose}
            className="rounded border border-white/20 px-3 py-2 font-mono text-[11.5px] uppercase tracking-[0.1em] text-white/60 transition hover:border-sell/60 hover:text-sell disabled:opacity-35"
          >
            close
          </button>
          <button
            type="button"
            onClick={onSound}
            className="rounded border border-white/20 px-3 py-2 font-mono text-[11.5px] uppercase tracking-[0.1em] text-white/60 transition hover:border-white/45"
            title={sound ? 'stop the room noise' : 'let the room make noise'}
          >
            {sound ? 'sound on' : 'sound off'}
          </button>
        </div>
      </div>
      <div className="mt-2 font-mono text-[10.5px] text-white/30">
        {messages} lines read · the engine moves only when the bell is rung
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'flag' }): React.ReactElement {
  return (
    <div>
      <dt className="text-white/35">{label}</dt>
      <dd className={`m-0 font-mono text-[14px] tnum ${tone === 'flag' ? 'text-flag' : 'text-paper'}`}>{value}</dd>
    </div>
  );
}

function Dossier({
  participant,
  currency,
  onClose,
}: {
  participant: SessionSnapshot['participants'][number];
  currency: SessionSnapshot['currency'];
  onClose: () => void;
}): React.ReactElement {
  const left = participant.role === 'buy' ? participant.budgetMinor - participant.spentMinor : participant.inventory - participant.soldQty;
  const unit = participant.role === 'buy' ? cash(left, currency) : `${left} lots`;
  return (
    <section className="brass-edge rounded-lg bg-felt/60 p-4">
      <div className="flex items-baseline gap-3">
        <h3 className="font-display text-[17px] text-paper">{participant.name}</h3>
        <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${participant.role === 'buy' ? 'text-buy' : 'text-sell'}`}>
          {participant.role} · {participant.instrument}
        </span>
        <button type="button" onClick={onClose} className="ml-auto font-mono text-[11px] text-white/40 hover:text-white/70">
          close
        </button>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-white/60">{participant.description}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11.5px] sm:grid-cols-4">
        <Cell label="will not go past" value={cash(participant.reservationMinor, currency)} />
        <Cell label="opening idea" value={cash(participant.targetMinor, currency)} />
        <Cell label="left to spend" value={unit} />
        <Cell label="rounds it waits" value={String(participant.horizonTicks)} />
        <Cell label="quotes shouted" value={String(participant.quotesShouted)} />
        <Cell label="as maker" value={String(participant.fillsAsMaker)} />
        <Cell label="as taker" value={String(participant.fillsAsTaker)} />
        <Cell label="concession" value={`${Math.round(participant.pressure * 100)}%`} />
      </dl>
      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.round(participant.pressure * 100)}%`, background: participant.role === 'buy' ? '#3fbf9a' : '#e2683f' }}
          />
        </div>
        <p className="mt-1 text-[11px] text-white/40">
          How far down its own concession curve this house has walked. The line it will not cross is its reservation price, and that number is
          never on the tape - it is this house's own secret.
        </p>
      </div>
      <div className="mt-2 font-mono text-[10px] text-white/30">ed25519 {shortKey(participant.key)}</div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-white/35">{label}</dt>
      <dd className="m-0 text-paper tnum">{value}</dd>
    </div>
  );
}

function Inspector({
  message,
  currency,
  snapshot,
  tamper,
  onForge,
  onClose,
}: {
  message: SealedMessage | null;
  currency: SessionSnapshot['currency'];
  snapshot: SessionSnapshot;
  tamper: { seq: number; total: number; first: readonly string[] } | null;
  onForge: (seq: number, field: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [field, setField] = useState('');
  if (message === null) {
    return (
      <section className="brass-edge rounded-lg bg-felt/55 p-4">
        <h3 className="font-display text-[16px] text-paper">A line of the tape</h3>
        <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">
          Pick any line to read what was actually signed - the body hash, the seal of the message before it, and the signature over both. You can
          then change one number in that line and watch the audit refuse the rest of the log. The demonstration works on a copy: the floor's own
          tape is never touched.
        </p>
        {tamper !== null && <TamperResult tamper={tamper} />}
      </section>
    );
  }
  const keys = Object.keys(message.payload);
  const chosen = keys.includes(field) ? field : (keys[0] ?? '');
  const findings = snapshot.verification.findings.filter((finding) => finding.seq === message.seq);
  return (
    <section className="brass-edge rounded-lg bg-felt/55 p-4">
      <div className="flex items-baseline gap-3">
        <h3 className="font-display text-[16px] text-paper">seq {message.seq}</h3>
        <span className="font-mono text-[11px] text-brass">{message.type}</span>
        <button type="button" onClick={onClose} className="ml-auto font-mono text-[11px] text-white/40 hover:text-white/70">
          close
        </button>
      </div>
      <div className="mt-1 font-mono text-[11px] text-white/45">
        {message.actor} · {new Date(message.ts).toISOString()}
      </div>
      <dl className="mt-3 space-y-2 font-mono text-[10.5px]">
        <Line label="bodyHash" value={message.bodyHash} />
        <Line label="prevHash" value={message.prevHash} />
        <Line label="signature" value={message.sig} />
        <Line label="key" value={message.key} />
      </dl>
      <pre className="mt-3 max-h-52 overflow-auto rounded bg-ink/70 p-3 font-mono text-[11px] leading-relaxed text-paper-2">
        {JSON.stringify(message.payload, null, 2)}
      </pre>
      {findings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {findings.map((finding, index) => (
            <li key={index} className="text-[12px] text-alarm">
              {finding.code}: {finding.detail}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[11px] text-white/45">
          change
          <select
            value={chosen}
            onChange={(event) => setField(event.target.value)}
            className="rounded border border-white/15 bg-ink px-2 py-1 font-mono text-[11px] text-paper"
          >
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => onForge(message.seq, chosen)}
          className="rounded border border-alarm/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-alarm transition hover:bg-alarm/15"
          title="Rewrite this line by one unit on a copy of the tape and run the audit over it"
        >
          edit it on purpose
        </button>
        <span className="text-[10.5px] text-white/30">
          {currency} amounts are minor units
        </span>
      </div>
      {tamper !== null && tamper.seq === message.seq && <TamperResult tamper={tamper} />}
    </section>
  );
}

function TamperResult({ tamper }: { tamper: { seq: number; total: number; first: readonly string[] } }): React.ReactElement {
  return (
    <div className="mt-3 rounded border border-alarm/40 bg-alarm/8 p-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-alarm">the audit says</div>
      <ul className="mt-2 space-y-1 text-[12px] text-paper-2">
        {tamper.first.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-white/45">
        One number changed in one of {tamper.total} lines. Everything after it is now unverifiable, which is the only promise a log like this can
        make.
      </p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-white/35">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 break-all text-white/60">{value}</dd>
    </div>
  );
}
