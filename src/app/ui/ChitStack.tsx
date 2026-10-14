import { useState } from 'react';
import type { SessionSnapshot, SerializedTrade } from '../../core/world';
import type { CurrencyCode } from '../../core/money';
import { cash, clockOf } from './format';
import { thump } from './sound';

/**
 * The pile in front of the human.
 *
 * A chit is a settlement that will not move until somebody reads it and decides. The rule that
 * caught it is printed on the chit in plain words, because "held by rule concentration" is not a
 * decision - "this seller is carrying more of the session than one account should" is. Refusing
 * takes the money back out of escrow and says why on the tape; letting it through captures and pays
 * the seller.
 *
 * Below the codes, a person can have the crier read the card: one paragraph from the floor's
 * interpreter, which is a language model when one answers on this machine and a fixed template when
 * none does. The chit says which of the two wrote it, because somebody is about to sign a decision
 * off these words.
 */

export type TradeActionKind = 'release' | 'veto' | 'refund' | 'partial_refund' | 'payout';

/** What the floor's interpreter came back with for one chit. */
export interface ChitVoice {
  text: string;
  spokenBy: string;
  source: string;
}

type Policy = SessionSnapshot['policy'];

/** What the rule actually says, with the floor's own numbers in it. */
function ruleLine(ruleId: string, policy: Policy, currency: CurrencyCode): string {
  switch (ruleId) {
    case 'size':
      return `the auto-settle line is ${cash(policy.autoSettleLimitMinor, currency)} a ticket`;
    case 'stray_price':
      return `a fill more than ${(policy.strayPriceBps / 100).toFixed(1)}% away from the last print`;
    case 'unrated':
      return `one side stands under ${policy.minReputationBps} bps of standing in the pit`;
    case 'first_pairing':
      return `two strangers settling over ${cash(policy.firstPairingReviewMinor, currency)} for the first time`;
    case 'concentration':
      return `one account taking more than ${cash(policy.sessionExposureCapMinor, currency)} in a session`;
    case 'awaiting_approval':
      return `the processor is still holding this order for its buyer`;
    default:
      return '';
  }
}

export default function ChitStack({
  trades,
  currency,
  policy,
  onAction,
  onRead,
  crier,
  crierSource,
  busy,
}: {
  trades: readonly SerializedTrade[];
  currency: CurrencyCode;
  policy: Policy;
  onAction: (action: TradeActionKind, tradeId: string, note?: string, amountMinor?: number) => Promise<string | null>;
  onRead: (tradeId: string) => Promise<ChitVoice | string>;
  /** Who writes a brief on this machine, worked out before anybody asks for one. */
  crier: string;
  /** Whether that is a model or the template, so a card can say why it fell back rather than guess. */
  crierSource: string;
  busy: boolean;
}): React.ReactElement {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [flashing, setFlashing] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<Record<string, ChitVoice>>({});
  const [reading, setReading] = useState<string | null>(null);
  const [readFailure, setReadFailure] = useState<Record<string, string>>({});

  async function ask(tradeId: string): Promise<void> {
    setReading(tradeId);
    setReadFailure((current) => ({ ...current, [tradeId]: '' }));
    const answer = await onRead(tradeId);
    if (typeof answer === 'string') setReadFailure((current) => ({ ...current, [tradeId]: answer }));
    else setBriefs((current) => ({ ...current, [tradeId]: answer }));
    setReading(null);
  }

  async function decide(action: TradeActionKind, tradeId: string): Promise<void> {
    setFlashing(`${action}:${tradeId}`);
    const note = (notes[tradeId] ?? '').trim();
    const failure = await onAction(action, tradeId, note.length > 0 ? note : undefined);
    thump(failure === null ? (action === 'veto' ? [18, 40, 26] : 22) : [8, 30, 8]);
    if (failure === null) {
      setNotes((current) => ({ ...current, [tradeId]: '' }));
      // The chit is off the pile, so its brief goes with it - the next card is a different question.
      setBriefs((current) => {
        const rest: Record<string, ChitVoice> = {};
        for (const [key, value] of Object.entries(current)) if (key !== tradeId) rest[key] = value;
        return rest;
      });
    }
    setTimeout(() => setFlashing(null), 500);
  }

  if (trades.length === 0) {
    return (
      <section className="brass-edge rounded-lg bg-felt/55 p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-display text-[16px] text-paper">The human pile</h3>
          <span className="font-mono text-[11px] text-brass">empty</span>
        </div>
        <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/35">the crier here is {crier}</p>
        <p className="mt-3 rounded border border-dashed border-white/15 px-4 py-8 text-center text-[12.5px] text-white/35">
          Nothing is waiting on a person. When a settlement trips a rule, or the processor is still
          holding an order for its buyer, it lands here with the reason written on it.
        </p>
      </section>
    );
  }

  return (
    <section className="brass-edge rounded-lg bg-felt/55 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-[16px] text-paper">The human pile</h3>
        <span className="font-mono text-[11px] text-brass">{trades.length} chit(s)</span>
      </div>
      <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/35">the crier here is {crier}</p>
      <ul className="mt-3 space-y-3">
        {trades.map((trade, index) => {
          const awaiting = trade.vetoRules.includes('awaiting_approval');
          return (
            <li
              key={trade.id}
              className="paper relative rounded p-3 transition"
              style={{ transform: `rotate(${index % 2 === 0 ? -0.5 : 0.6}deg)` }}
            >
              <span className="absolute -top-2 left-1/2 h-4 w-10 -translate-x-1/2 rounded-sm bg-brass/70 shadow" aria-hidden="true" />
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a6a4f]">{trade.instrument}</span>
                <span className="font-mono text-[15px] text-[#1d6a51] tnum">{cash(trade.grossMinor, currency)}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-[#4a4238]">
                {trade.buyer} <span className="text-[#a84d24]">→</span> {trade.seller}
              </div>
              <ul className="mt-2 space-y-1">
                {trade.vetoReasons.length === 0 ? (
                  <li className="text-[12px] text-[#4a4238]">held without a stated rule</li>
                ) : (
                  trade.vetoReasons.map((reason, position) => (
                    <li key={`${trade.id}-${position}`} className="text-[12px] leading-snug text-[#3a3226]">
                      <span className="mr-1 font-mono text-[10px] uppercase tracking-wide text-[#a84d24]">{trade.vetoRules[position] ?? 'rule'}</span>
                      {reason}
                      {(() => {
                        const line = ruleLine(trade.vetoRules[position] ?? '', policy, currency);
                        return line.length > 0 ? <span className="mt-0.5 block font-mono text-[10.5px] text-[#7a6a4f]">{line}</span> : null;
                      })()}
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-1 font-mono text-[10px] text-[#7a6a4f]">
                {trade.phase} · booked {clockOf(trade.createdAt)} · {trade.id.slice(-8)}
              </div>
              {awaiting && trade.approvalUrl !== null && (
                <a
                  href={trade.approvalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block rounded bg-[#1d6a51] px-2 py-1 text-center font-mono text-[11px] text-paper no-underline hover:bg-[#22795c]"
                >
                  the buyer still has the approval page open - open it
                </a>
              )}
              {(() => {
                const brief = briefs[trade.id];
                const failed = readFailure[trade.id] ?? '';
                if (brief !== undefined) {
                  return (
                    <div className="mt-2 border-l-2 border-[#a84d24]/50 pl-2.5">
                      <p className="text-[12.5px] leading-snug text-[#26201a]">{brief.text}</p>
                      <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[#8a7a5c]">
                        {brief.source === 'template'
                          ? crierSource === 'template'
                            ? 'written by the desk template - no model answers on this machine, and the numbers above are the record either way'
                            : `written by the desk template - ${crier} was asked about this card and either did not answer or contradicted the record, so its reading was thrown away`
                          : `written by ${brief.spokenBy} - it talks about the figures on this card and moves none of them`}
                      </p>
                    </div>
                  );
                }
                return (
                  <button
                    type="button"
                    onClick={() => void ask(trade.id)}
                    disabled={reading !== null}
                    className="mt-2 w-full rounded border border-[#c4b795] px-2 py-1 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#5a4d3a] transition hover:bg-[#f3ead6] disabled:opacity-45"
                  >
                    {reading === trade.id ? 'the crier is reading it, one moment' : failed.length > 0 ? 'try the crier again' : 'have the crier read this chit'}
                  </button>
                );
              })()}
              {(() => {
                const failed = readFailure[trade.id] ?? '';
                return failed.length > 0 ? <p className="mt-1 text-[11px] text-[#a84d24]">{failed}</p> : null;
              })()}
              <input
                value={notes[trade.id] ?? ''}
                onChange={(event) => setNotes((current) => ({ ...current, [trade.id]: event.target.value }))}
                placeholder="say why, if you refuse it"
                className="mt-2 w-full rounded border border-[#c4b795] bg-[#fbf6ea] px-2 py-1 font-mono text-[11.5px] text-[#26201a] outline-none placeholder:text-[#9c8f74]"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide('release', trade.id)}
                  className={`flex-1 rounded bg-[#1d6a51] px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-paper transition hover:bg-[#22795c] disabled:opacity-40 ${
                    flashing === `release:${trade.id}` ? 'knock' : ''
                  }`}
                >
                  let it through
                </button>
                <button
                  type="button"
                  disabled={busy || (trade.phase !== 'funded' && !awaiting)}
                  onClick={() => void decide('veto', trade.id)}
                  title={trade.phase === 'funded' ? 'void the order and give the buyer their money back' : `a ${trade.phase} trade has moved past a veto`}
                  className={`flex-1 rounded bg-[#a84d24] px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-paper transition hover:bg-[#b9582c] disabled:opacity-40 ${
                    flashing === `veto:${trade.id}` ? 'knock' : ''
                  }`}
                >
                  refuse it
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
