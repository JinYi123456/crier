'use client';

import { useCallback, useMemo, useState } from 'react';
import type { LedgerEntry } from '../../core/ledger';
import type { SealedMessage } from '../../core/protocol';
import type { SessionSnapshot } from '../../core/world';
import JournalGrid from './JournalGrid';
import Tape from './Tape';
import type { Envelope } from './envelope';
import { cash, clockOf, shortKey } from './format';

/**
 * The audit room.
 *
 * Where the pit is about watching a market decide, this is about checking what it did: the chain
 * verdict, the books as a grid you can sort and filter, and a scrubber that walks the tape back to
 * any line so you can stand at the moment the money moved and read the journal as it stood there.
 */

const NORMAL_SIDE: Record<string, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

interface Room {
  readonly id: string;
  readonly seed: string;
  readonly tick: number;
  readonly maxTicks: number;
  readonly trades: number;
  readonly closed: boolean;
}

export default function AuditRoom({
  id,
  initial,
  rooms,
}: {
  id: string;
  initial: Envelope;
  rooms: readonly Room[];
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(initial.snapshot);
  const [upto, setUpto] = useState<number | null>(null);
  const [inspect, setInspect] = useState<SealedMessage | null>(null);
  const [notice, setNotice] = useState('');

  const head = snapshot.messages.length > 0 ? (snapshot.messages[snapshot.messages.length - 1]?.seq ?? 0) : 0;
  const shown = upto === null ? head : Math.min(upto, head);
  const visible = useMemo(() => snapshot.messages.filter((message) => message.seq <= shown), [snapshot.messages, shown]);
  const visibleEntries = useMemo(() => snapshot.entries.filter((entry) => entry.seq <= shown), [snapshot.entries, shown]);
  const findings = snapshot.verification.findings;

  const reread = useCallback(async () => {
    const response = await fetch(`/api/floor/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const body = (await response.json()) as Partial<Envelope> & { error?: string };
    if (body.snapshot === undefined) {
      setNotice(body.error ?? 'the room would not answer');
      return;
    }
    setSnapshot(body.snapshot);
    setNotice(`${String(body.snapshot.messages.length)} sealed lines read`);
  }, [id]);

  const balances = useMemo(() => {
    const totals = new Map<string, { debit: number; credit: number }>();
    for (const entry of visibleEntries) {
      for (const posting of entry.postings) {
        const row = totals.get(posting.account) ?? { debit: 0, credit: 0 };
        row.debit += posting.debit;
        row.credit += posting.credit;
        totals.set(posting.account, row);
      }
    }
    const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
    const rows = [...totals.entries()].map(([accountId, row]) => {
      const account = accounts.get(accountId);
      const normal = NORMAL_SIDE[account?.type ?? 'asset'] ?? 'debit';
      return {
        id: accountId,
        name: account?.name ?? accountId,
        type: account?.type ?? 'asset',
        balance: normal === 'debit' ? row.debit - row.credit : row.credit - row.debit,
      };
    });
    const widest = Math.max(1, ...rows.map((row) => Math.abs(row.balance)));
    return { rows: rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)), widest };
  }, [visibleEntries, snapshot.accounts]);

  const debits = visibleEntries.reduce((total, entry) => total + entry.postings.reduce((sum, posting) => sum + posting.debit, 0), 0);
  const credits = visibleEntries.reduce((total, entry) => total + entry.postings.reduce((sum, posting) => sum + posting.credit, 0), 0);

  return (
    <div className="pt-5">
      <div className="brass-edge flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg bg-felt/70 px-4 py-3">
        <div>
          <h1 className="font-display text-[21px] leading-none text-paper">The audit room</h1>
          <p className="mt-1 font-mono text-[10.5px] text-white/40">{id}</p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-[11px]">
          <Field label="seed" value={snapshot.seed} />
          <Field label="round" value={`${snapshot.tick}/${snapshot.maxTicks}`} />
          <Field label="sealed lines" value={String(head + 1)} />
          <Field label="postings" value={String(snapshot.entries.length)} />
          <Field label="processor" value={snapshot.gateway} />
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a
            href={`/floor/${encodeURIComponent(id)}`}
            className="rounded border border-white/20 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/70 no-underline hover:border-brass hover:text-brass"
          >
            back to the pit
          </a>
          <a
            href={`/api/floor/${encodeURIComponent(id)}/tape`}
            download={`${id}.tape.json`}
            className="rounded border border-white/20 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/70 no-underline hover:border-brass hover:text-brass"
          >
            take the tape
          </a>
          <button
            type="button"
            onClick={() => void reread()}
            className="rounded border border-brass/60 bg-brass/12 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-brass hover:bg-brass/20"
          >
            re-read the tape
          </button>
        </div>
      </div>

      {notice.length > 0 && <p className="mt-3 rounded bg-brass/12 px-3 py-2 text-[12px] text-brass">{notice}</p>}

      {rooms.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {rooms.map((room) => (
            <a
              key={room.id}
              href={`/audit?floor=${encodeURIComponent(room.id)}`}
              className={`rounded-full border px-3 py-1 font-mono text-[11px] no-underline transition ${
                room.id === id ? 'border-brass bg-brass/18 text-brass' : 'border-white/15 text-white/55 hover:border-white/35'
              }`}
            >
              {room.seed} {room.closed ? '(closed)' : `· ${room.tick}/${room.maxTicks}`}
            </a>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)]">
        <div className="space-y-4">
          <section className="brass-edge rounded-lg bg-ink/70 p-4">
            <div className="flex flex-wrap items-center gap-4">
              <Stamp ok={snapshot.verification.ok} />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-relaxed text-white/60">
                  {snapshot.verification.ok
                    ? 'Every line on this tape carries the seal of the line before it and a signature from the house that spoke it. Nothing here has been edited.'
                    : 'This tape does not verify. The lines below are where the audit stopped trusting the record, and every seal after the edit is broken as well.'}
                </p>
                <p className="mt-2 font-mono text-[11px] text-white/40">
                  head {shortKey(snapshot.headHash)} · verified up to {snapshot.verification.verifiedUpToSeq === null ? 'nothing' : `line ${String(snapshot.verification.verifiedUpToSeq)}`} ·{' '}
                  {String(findings.length)} finding(s)
                </p>
              </div>
            </div>
            {findings.length > 0 && (
              <ul className="mt-3 max-h-[160px] space-y-1 overflow-y-auto font-mono text-[11px]">
                {findings.slice(0, 40).map((finding) => (
                  <li key={`${finding.seq}-${finding.code}`} className="flex gap-3">
                    <span className="w-12 shrink-0 text-alarm tnum">line {String(finding.seq)}</span>
                    <span className="w-40 shrink-0 text-alarm/80">{finding.code}</span>
                    <span className="min-w-0 flex-1 truncate text-white/50" title={finding.detail}>
                      {finding.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="brass-edge rounded-lg bg-ink/70 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">Walk the tape</h2>
              <p className="font-mono text-[11px] text-white/45">
                reading the room as of line {String(shown)}
                {visible.length > 0 ? ` · ${clockOf(visible[visible.length - 1]?.ts ?? 0)} utc` : ''}
              </p>
            </div>
            <TapeStrip messages={snapshot.messages} findings={findings} upto={shown} onPick={setUpto} />
            <input
              type="range"
              min={0}
              max={head}
              step={1}
              value={shown}
              onChange={(event) => setUpto(Number(event.target.value))}
              className="scrubber mt-2 w-full"
              aria-label="Which line of the tape to read up to"
            />
            <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
              <Scrub to={0} onPick={setUpto} label="the opening" />
              <Scrub to={Math.round(head / 2)} onPick={setUpto} label="halfway" />
              <Scrub to={head} onPick={setUpto} label="now" />
              {findings[0] ? <Scrub to={findings[0].seq} onPick={setUpto} label="where it broke" bad /> : null}
            </div>
          </section>

          <JournalGrid entries={visibleEntries} accounts={snapshot.accounts} currency={snapshot.currency} />
        </div>

        <div className="space-y-4">
          <section className="brass-edge rounded-lg bg-felt/60 p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">Trial balance</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/55">
              Every entry has at least two sides and they have to add up to the unit. This is what the machine checks before it lets a settlement
              move, recomputed here from the postings up to line {String(shown)}.
            </p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2 font-mono text-[12px]">
              <span className="text-white/50">debits {cash(debits, snapshot.currency)}</span>
              <span className="text-white/50">credits {cash(credits, snapshot.currency)}</span>
              <span className={debits === credits ? 'text-good' : 'text-alarm'}>{debits === credits ? 'balanced' : 'IMBALANCED'}</span>
            </div>
            <ul className="mt-4 space-y-2">
              {balances.rows.map((row) => (
                <li key={row.id}>
                  <div className="flex items-baseline justify-between gap-3 font-mono text-[11px]">
                    <span className="min-w-0 truncate text-white/60" title={row.id}>
                      {row.name}
                    </span>
                    <span className="shrink-0 text-paper tnum">{cash(row.balance, snapshot.currency)}</span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, (Math.abs(row.balance) / balances.widest) * 100)}%`,
                        background: row.type === 'revenue' ? '#d9a441' : row.type === 'liability' ? '#e2683f' : '#3fbf9a',
                      }}
                    />
                  </div>
                </li>
              ))}
              {balances.rows.length === 0 && <li className="font-mono text-[11px] text-white/35">no postings before this line</li>}
            </ul>
          </section>

          <section className="brass-edge rounded-lg bg-felt/60 p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">Where the money is</h2>
            <dl className="mt-2 grid grid-cols-1 gap-y-2 font-mono text-[11.5px] sm:grid-cols-2">
              <Field label="across the tape" value={cash(snapshot.summary.grossMinor, snapshot.currency)} />
              <Field label="kept as fee" value={cash(snapshot.summary.feeMinor, snapshot.currency)} />
              <Field label="owed out" value={cash(snapshot.summary.netMinor, snapshot.currency)} />
              <Field label="given back" value={cash(snapshot.summary.refundedMinor, snapshot.currency)} />
              <Field label="waiting on a person" value={String(snapshot.summary.heldTrades)} />
              <Field label="trades" value={String(snapshot.summary.trades)} />
            </dl>
            <p className="mt-3 text-[12px] leading-relaxed text-white/45">
              Phases: {Object.entries(snapshot.summary.byPhase).map(([phase, count]) => `${phase} ${String(count)}`).join(' · ')}
            </p>
          </section>

          {inspect !== null && (
            <section className="brass-edge rounded-lg bg-felt/60 p-4">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">Line {String(inspect.seq)}</h2>
              <p className="mt-2 font-mono text-[11px] text-white/50">{inspect.type} · {inspect.actor} · {clockOf(inspect.ts)} utc</p>
              <pre className="mt-2 max-h-[220px] overflow-auto rounded bg-ink/70 p-2 font-mono text-[10.5px] leading-relaxed text-white/55">
                {JSON.stringify(inspect.payload, null, 2)}
              </pre>
              <p className="mt-2 font-mono text-[10px] text-white/35">
                body {shortKey(inspect.bodyHash)} · prev {shortKey(inspect.prevHash)}
              </p>
              <button type="button" onClick={() => setInspect(null)} className="mt-2 font-mono text-[11px] text-white/40 hover:text-white/70">
                dismiss
              </button>
            </section>
          )}
        </div>
      </div>

      <div className="mt-4 max-h-[560px]">
        <Tape messages={visible} findings={findings} currency={snapshot.currency} selectedSeq={inspect?.seq ?? null} onSelect={setInspect} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">{label}</dt>
      <dd className="m-0 font-mono text-[13px] text-paper tnum">{value}</dd>
    </div>
  );
}

function Stamp({ ok }: { ok: boolean }): React.ReactElement {
  return (
    <div
      className={`shrink-0 rounded border-2 px-3 py-2 text-center font-mono text-[12px] uppercase tracking-[0.18em] ${
        ok ? 'border-good/70 text-good' : 'border-alarm text-alarm rotate-[-2deg]'
      }`}
    >
      {ok ? 'tape verifies' : 'tape broken'}
    </div>
  );
}

function Scrub({ to, label, onPick, bad }: { to: number; label: string; onPick: (seq: number) => void; bad?: boolean }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onPick(to)}
      className={`rounded-full border px-3 py-1 uppercase tracking-[0.12em] transition ${
        bad ? 'border-alarm/60 text-alarm hover:bg-alarm/12' : 'border-white/15 text-white/55 hover:border-brass hover:text-brass'
      }`}
    >
      {label}
    </button>
  );
}

/** The whole tape as one band of ticks, so a broken line is visible from across the room. */
function TapeStrip({
  messages,
  findings,
  upto,
  onPick,
}: {
  messages: readonly SealedMessage[];
  findings: readonly { seq: number }[];
  upto: number;
  onPick: (seq: number) => void;
}): React.ReactElement {
  const broken = new Set(findings.map((finding) => finding.seq));
  const width = 1000;
  const step = messages.length > 1 ? width / (messages.length - 1) : width;
  return (
    <svg viewBox={`0 0 ${width} 40`} className="mt-3 w-full" role="img" aria-label="Every sealed line, with the ones the audit does not trust marked in red">
      <line x1="0" y1="30" x2={width} y2="30" stroke="rgba(255,255,255,0.1)" />
      {messages.map((message, index) => {
        const x = index * step;
        const fault = broken.has(message.seq);
        const past = message.seq > upto;
        return (
          <rect
            key={message.seq}
            x={x}
            y={fault ? 6 : 14}
            width={Math.max(1.2, step * 0.6)}
            height={fault ? 24 : 16}
            fill={fault ? '#e2683f' : past ? 'rgba(217,164,65,0.22)' : '#d9a441'}
            opacity={past ? 0.5 : 1}
            onClick={() => onPick(message.seq)}
            className="cursor-pointer"
          >
            <title>{`line ${String(message.seq)} · ${message.type}${fault ? ' · the audit does not trust this one' : ''}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
