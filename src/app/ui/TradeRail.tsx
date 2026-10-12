import { useState } from 'react';
import type { SerializedTrade } from '../../core/world';
import { fromDecimalString, type CurrencyCode } from '../../core/money';
import { cash, clockOf } from './format';
import type { TradeActionKind } from './ChitStack';

/**
 * Every trade the floor has booked, and what has happened to each one.
 *
 * A row is a trade; opening it shows the steps it took - funded, approved, captured, paid out,
 * refunded - with the processor's own references beside each. Those references are the reason the
 * screen exists: a settlement that cannot name its capture is a settlement nobody can check.
 */

const PHASE_COLOUR: Record<string, string> = {
  matched: 'text-white/50',
  funded: 'text-flag',
  awaiting_approval: 'text-flag',
  approved: 'text-brass',
  captured: 'text-buy',
  paid_out: 'text-buy',
  refunded: 'text-paper-2',
  voided: 'text-sell',
  failed: 'text-alarm',
};

export default function TradeRail({
  trades,
  currency,
  onAction,
  busy,
}: {
  trades: readonly SerializedTrade[];
  currency: CurrencyCode;
  onAction: (action: TradeActionKind, tradeId: string, note?: string, amountMinor?: number) => Promise<string | null>;
  busy: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  // A person types what they would say out loud; the engine only ever counts minor units.
  const amountMinor = (() => {
    const text = amount.trim();
    if (text.length === 0) return undefined;
    try {
      return fromDecimalString(currency, text).minor;
    } catch {
      return undefined;
    }
  })();

  if (trades.length === 0) {
    return (
      <section className="brass-edge rounded-lg bg-felt/55 p-4">
        <h3 className="font-display text-[16px] text-paper">Trades</h3>
        <p className="mt-3 text-[12.5px] text-white/35">Nothing has been booked yet. Ring the bell and the houses will start shouting.</p>
      </section>
    );
  }

  return (
    <section className="brass-edge rounded-lg bg-felt/55 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-[16px] text-paper">Trades</h3>
        <span className="font-mono text-[11px] text-white/40">{trades.length}</span>
      </div>
      <ul className="mt-2 divide-y divide-white/8">
        {trades.map((trade) => {
          const expanded = open === trade.id;
          const refundable = trade.phase === 'captured' || trade.phase === 'paid_out';
          return (
            <li key={trade.id} className="py-1.5">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : trade.id)}
                className="flex w-full items-baseline gap-2 text-left"
                aria-expanded={expanded}
              >
                <span className={`w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] ${PHASE_COLOUR[trade.phase] ?? 'text-white/50'}`}>
                  {trade.phase}
                </span>
                <span className="w-24 shrink-0 font-mono text-[11px] text-white/50">{trade.instrument}</span>
                <span className="w-20 shrink-0 text-right font-mono text-[12.5px] text-paper tnum">{cash(trade.grossMinor, currency)}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-white/30">
                  {trade.held ? 'on the pile' : `${trade.steps.length} step(s)`}
                </span>
              </button>

              {expanded && (
                <div className="mt-2 rounded bg-ink/50 p-3">
                  <div className="font-mono text-[11px] text-white/45">
                    {trade.buyer} <span className="text-sell">→</span> {trade.seller} · fee {cash(trade.feeMinor, currency)} · net{' '}
                    {cash(trade.netMinor, currency)} · refund {cash(trade.refundedMinor, currency)}
                  </div>
                  <ol className="mt-2 space-y-1">
                    {trade.steps.map((step, index) => (
                      <li key={`${trade.id}-${index}`} className="flex gap-2 font-mono text-[11px]">
                        <span className="w-14 shrink-0 text-white/30">{clockOf(step.at)}</span>
                        <span className="w-20 shrink-0 text-brass/85">{step.phase}</span>
                        <span className="min-w-0 flex-1 text-white/55">{step.note}</span>
                      </li>
                    ))}
                  </ol>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[10.5px] text-white/40 sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-white/30">order</dt>
                      <dd className="m-0 text-white/55">{trade.orderId || '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-white/30">capture</dt>
                      <dd className="m-0 text-white/55">{trade.captureReference || '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-white/30">payout</dt>
                      <dd className="m-0 text-white/55">{trade.payoutReference || '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-white/30">refunds</dt>
                      <dd className="m-0 text-white/55">{trade.refundReferences.join(', ') || '—'}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-white/30">entries</dt>
                      <dd className="m-0 text-white/55">{trade.entries.length}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-white/30">tape</dt>
                      <dd className="m-0 text-white/55">{trade.messages.map((seq) => `#${seq}`).join(' ') || '—'}</dd>
                    </div>
                  </dl>
                  {trade.failure !== null && <p className="mt-2 text-[12px] text-alarm">{trade.failure}</p>}
                  {trade.vetoNote !== null && trade.vetoNote.length > 0 && <p className="mt-2 text-[12px] text-sell">refused: {trade.vetoNote}</p>}

                  {refundable && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder={cash(trade.grossMinor - trade.refundedMinor, currency)}
                        inputMode="decimal"
                        className="w-28 rounded border border-white/15 bg-ink px-2 py-1 font-mono text-[11px] text-paper outline-none focus:border-brass/60"
                        aria-label="how much to give the buyer back"
                      />
                      <button
                        type="button"
                        disabled={busy || amountMinor === undefined}
                        onClick={() => void onAction('partial_refund', trade.id, 'short count', amountMinor)}
                        className="rounded border border-brass/50 px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-brass hover:bg-brass/15 disabled:opacity-40"
                      >
                        refund that much
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onAction('refund', trade.id, 'buyer changed mind')}
                        className="rounded border border-white/20 px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-white/70 hover:bg-white/10 disabled:opacity-40"
                      >
                        refund it all
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
