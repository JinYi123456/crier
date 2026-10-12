import type { TradeRecord } from '../../core/settlement';
import { cash, clockOf } from './format';

/**
 * The slip a buyer gets back from the processor.
 *
 * PayPal sends the browser here with nothing but a trade id, so this is the one page in the app that
 * has to speak to somebody who is not running the floor. It says three things and no more: what the
 * processor told us, what the floor has done about it, and who still has to act. It never settles
 * anything - a page the buyer's browser loads cannot also be the place a human signs a capture.
 */

type Verdict = 'captured' | 'paid' | 'approved' | 'still-open' | 'refunded' | 'voided' | 'held' | 'failed' | 'nowhere';

function verdictOf(trade: TradeRecord | null, awaitingBuyer: boolean | null): Verdict {
  if (trade === null) return 'nowhere';
  switch (trade.phase) {
    case 'paid_out':
      return 'paid';
    case 'captured':
      return 'captured';
    case 'refunded':
      return 'refunded';
    case 'voided':
      return 'voided';
    case 'failed':
      return 'failed';
    default:
      break;
  }
  if (awaitingBuyer === true) return 'still-open';
  // A hold of the floor's own making outranks what the processor says: the buyer has done their part
  // and a person still has not.
  if (trade.held) {
    return trade.vetoRules.some((rule) => rule !== 'awaiting_approval') ? 'held' : 'approved';
  }
  return 'approved';
}

const WORDING: Record<Verdict, { readonly head: string; readonly body: string; readonly tone: 'good' | 'bad' | 'wait' }> = {
  captured: { head: 'the money is taken', body: 'The order is captured and the fee is on the books. The seller is paid or queued for payment by the floor itself.', tone: 'good' },
  paid: { head: 'the seller has been paid', body: 'Capture, fee and payout are all against this trade, each one with the reference the processor gave it beside the step.', tone: 'good' },
  approved: { head: 'you approved it - the floor has not taken it yet', body: 'The processor says this order is approved and no longer waiting on you. Nothing here captures it: that happens on the pile, under a signature, by whoever runs the room.', tone: 'wait' },
  'still-open': {
    head: 'still waiting on you',
    body: 'The processor is holding this order open and no money has moved. Use the approval link on the chit in the pit, or leave it and the escrow stays exactly where it is.',
    tone: 'wait',
  },
  held: { head: 'a person has to decide', body: 'This settlement is on the human pile with the rule that caught it written on it. It will not move until somebody reads it out loud and signs the answer.', tone: 'wait' },
  refunded: { head: 'given back', body: 'The buyer has been refunded, in whole or in part, and the refund carries its own processor reference.', tone: 'bad' },
  voided: { head: 'refused', body: 'Somebody on the floor vetoed this trade. The order is void and the escrow has been returned to the buyer unredeemed.', tone: 'bad' },
  failed: { head: 'it did not go through', body: 'The processor refused this settlement. The failure is on the tape with the reason the processor gave for it.', tone: 'bad' },
  nowhere: {
    head: 'this machine has no such trade',
    body: 'A floor lives in the memory of the process that opened it. If the room was opened elsewhere, or restarted since, the settlement is not here to report on - the tape it left behind still verifies anywhere.',
    tone: 'bad',
  },
};

export default function CheckoutSlip({
  kind,
  trade,
  floorId,
  awaitingBuyer,
}: {
  readonly kind: 'return' | 'cancel';
  readonly trade: TradeRecord | null;
  readonly floorId: string | null;
  readonly awaitingBuyer: boolean | null;
}): React.ReactElement {
  const verdict = verdictOf(trade, awaitingBuyer);
  const words = WORDING[verdict];
  const toneClass = words.tone === 'good' ? 'text-buy' : words.tone === 'bad' ? 'text-sell' : 'text-brass';

  return (
    <div className="mx-auto mt-10 max-w-[620px]">
      <div className="paper rounded-lg p-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-[#7a6a4f]">
            {kind === 'cancel' ? 'cancelled at the processor' : 'back from the processor'}
          </span>
          <span className="font-mono text-[10.5px] text-[#7a6a4f]">{trade === null ? 'no record' : clockOf(trade.updatedAt)}</span>
        </div>
        <h1 className={`mt-2 font-display text-[26px] leading-tight ${toneClass}`}>
          {words.head}
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#3a3226]">{words.body}</p>

        {trade !== null && (
          <>
            <div className="mt-4 border-t border-[#c4b795] pt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#7a6a4f]">{trade.instrument}</span>
                <span className="font-mono text-[17px] text-[#1d6a51] tnum">{cash(trade.grossMinor, trade.currency)}</span>
              </div>
              <div className="mt-1 font-mono text-[12px] text-[#4a4238]">
                {trade.buyer} <span className="text-[#a84d24]">&rarr;</span> {trade.seller}
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[11.5px] text-[#4a4238] sm:grid-cols-2">
                <dt className="text-[#7a6a4f]">phase</dt>
                <dd className="m-0">{trade.phase}</dd>
                <dt className="text-[#7a6a4f]">order</dt>
                <dd className="m-0 break-all">{trade.orderId ?? 'never opened'}</dd>
                <dt className="text-[#7a6a4f]">capture</dt>
                <dd className="m-0 break-all">{trade.captureReference ?? 'none'}</dd>
                <dt className="text-[#7a6a4f]">payout</dt>
                <dd className="m-0 break-all">{trade.payoutReference ?? 'none'}</dd>
                <dt className="text-[#7a6a4f]">refunded</dt>
                <dd className="m-0">{trade.refundedMinor > 0 ? cash(trade.refundedMinor, trade.currency) : 'nothing'}</dd>
              </dl>
              {trade.vetoReasons.length > 0 && (
                <ul className="mt-3 space-y-1 border-l-2 border-[#a84d24] pl-3">
                  {trade.vetoReasons.map((reason, index) => (
                    <li key={`${trade.id}-${index}`} className="text-[12.5px] leading-snug text-[#3a3226]">
                      <span className="mr-1 font-mono text-[10px] uppercase tracking-wide text-[#a84d24]">{trade.vetoRules[index] ?? 'rule'}</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
              {trade.steps.length > 0 && (
                <ol className="mt-3 space-y-0.5 font-mono text-[11px] text-[#5a5041]">
                  {trade.steps.map((step, index) => (
                    <li key={`${trade.id}-step-${index}`} className="flex gap-2">
                      <span className="w-[74px] shrink-0 text-[#7a6a4f]">{clockOf(step.at)}</span>
                      <span className="w-[128px] shrink-0">{step.phase}</span>
                      <span className="min-w-0">{step.note}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {trade.approvalUrl !== null && (
              <a
                href={trade.approvalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block rounded bg-[#1d6a51] px-3 py-2 text-center font-mono text-[12px] text-paper no-underline hover:bg-[#22795c]"
              >
                open the approval page again
              </a>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2 font-mono text-[12px]">
        {floorId !== null && (
          <>
            <a className="text-brass no-underline hover:underline" href={`/floor/${encodeURIComponent(floorId)}`}>
              back to the pit
            </a>
            <a className="text-white/55 no-underline hover:text-brass" href={`/audit?floor=${encodeURIComponent(floorId)}`}>
              read the tape
            </a>
          </>
        )}
        <a className="ml-auto text-white/40 no-underline hover:text-brass" href="/">
          open a floor
        </a>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-white/35">
        {kind === 'cancel'
          ? 'Cancelling at the processor takes nothing back out of escrow by itself. The trade stays where it was, on the pile, until a person on the floor refuses it or lets it through.'
          : 'Bringing the browser back is not an instruction to settle. Capture needs a signed decision, and the pile is where that decision gets made.'}
      </p>
    </div>
  );
}
