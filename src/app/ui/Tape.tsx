import type { Finding, MessageType, SealedMessage } from '../../core/protocol';
import type { CurrencyCode } from '../../core/money';
import { cash, clockOf, shortKey } from './format';

/**
 * The tape.
 *
 * Not a log of events but the signed record itself, in order, with the seal each message put on the
 * one before it. A line is colour-coded by who spoke and what kind of thing it was, and a line the
 * audit does not like gets marked where the damage is - which is the point of the whole room.
 */

type Tone = 'open' | 'shout' | 'print' | 'money' | 'human' | 'processor' | 'quiet';

const TONE_OF: Partial<Record<MessageType, Tone>> = {
  'market.open': 'open',
  'market.close': 'open',
  'floor.quote': 'shout',
  'floor.accept': 'print',
  'floor.walk_away': 'human',
  'book.order': 'quiet',
  'book.cancel': 'quiet',
  'book.match': 'print',
  'order.created': 'money',
  'order.approved': 'money',
  'order.captured': 'money',
  'order.voided': 'human',
  'order.failed': 'human',
  'payment.refunded': 'money',
  'payout.created': 'money',
  'payout.paid': 'money',
  'ledger.entry': 'quiet',
  'human.veto': 'human',
  'human.release': 'human',
  'human.override': 'human',
  'webhook.received': 'processor',
};

const COLOUR: Record<Tone, string> = {
  open: '#d9a441',
  shout: 'rgba(240,235,225,0.82)',
  print: '#f1e7d4',
  money: '#7fd6bb',
  human: '#e2683f',
  processor: '#a99bd6',
  quiet: 'rgba(220,214,200,0.42)',
};

const GLYPH: Partial<Record<MessageType, string>> = {
  'market.open': '▤',
  'market.close': '☐',
  'floor.quote': '❝',
  'floor.accept': '✔',
  'floor.walk_away': '✖',
  'book.order': '·',
  'book.cancel': '⌫',
  'book.match': '⨯',
  'order.created': '¤',
  'order.approved': '✓',
  'order.captured': '▣',
  'order.voided': '⊘',
  'order.failed': '!',
  'payment.refunded': '↩',
  'payout.created': '✉',
  'payout.paid': '$',
  'ledger.entry': '▦',
  'human.veto': '☝',
  'human.release': '☟',
  'webhook.received': '⇢',
};

function field(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function number(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' ? value : null;
}

/** One readable sentence per kind of thing said, so a stranger can follow the tape without a manual. */
export function gist(message: SealedMessage, currency: CurrencyCode): string {
  const p = message.payload;
  const minor = (key: string): string => {
    const value = number(p, key);
    return value === null ? '—' : cash(value, currency);
  };
  switch (message.type) {
    case 'market.open':
      return `the floor opens - ${field(p, 'currency')} board of ${field(p, 'instruments').split(',').length} market(s), ${String(p['houses'] ?? 0)} houses, ${String(p['maxTicks'] ?? 0)} rounds`;
    case 'market.close':
      return `the bell goes after ${String(p['ticks'] ?? 0)} rounds - ${String(p['trades'] ?? 0)} trades, ${minor('grossMinor')} across, ${String(p['heldTrades'] ?? 0)} left waiting`;
    case 'floor.quote': {
      const call = field(p, 'voice') || `${field(p, 'party')} ${field(p, 'side') === 'buy' ? 'bids' : 'offers'}`;
      const joined = field(p, 'kind') === 'limit' && field(p, 'side') === 'buy' ? 'for' : 'x';
      return `${call} ${minor('priceMinor')} ${joined} ${String(p['qty'] ?? 0)}`;
    }
    case 'floor.accept':
      return `done at ${minor('priceMinor')}`;
    case 'floor.walk_away':
      return `${field(p, 'party')} folds their hand - ${field(p, 'reason')}`;
    case 'book.order':
      return p['reference'] === true
        ? `${field(p, 'instrument')} opens the board at ${minor('openingMinor')} a lot (${field(p, 'lot')})`
        : `${field(p, 'side')} ${minor('priceMinor')} x ${String(p['qty'] ?? 0)} rests ${String(p['resting'] ?? 0)} of it`;
    case 'book.cancel':
      return `${field(p, 'party')} pulls ${field(p, 'orders')}`;
    case 'book.match':
      return `PRINT ${minor('priceMinor')} x ${String(p['qty'] ?? 0)} - ${field(p, 'buyer')} takes from ${field(p, 'seller')}`;
    case 'order.created':
      return `order ${shortKey(field(p, 'orderId'))} for ${minor('grossMinor')} on ${field(p, 'instrument')}`;
    case 'order.approved':
      return `processor approves ${shortKey(field(p, 'orderId'))}`;
    case 'order.captured':
      return `money taken - ${minor('grossMinor')} in, fee ${minor('feeMinor')}, ${minor('netMinor')} for the seller`;
    case 'order.voided':
      return `order ${shortKey(field(p, 'orderId'))} voided - ${field(p, 'reason')}`;
    case 'order.failed':
      return `settlement failed at ${field(p, 'stage')}: ${field(p, 'error') || field(p, 'reason')}`;
    case 'payment.refunded':
      return `${minor('amountMinor')} back to the buyer - ${field(p, 'reason')} (${field(p, 'source')} paid it)`;
    case 'payout.created':
      return `payout ${shortKey(field(p, 'payoutId'))} drawn for ${field(p, 'recipient')}`;
    case 'payout.paid':
      return `seller paid ${minor('amountMinor')} - ${field(p, 'status')}`;
    case 'ledger.entry':
      return `${field(p, 'code')} - ${field(p, 'account')} ${minor('amountMinor')} · ${field(p, 'memo')}`;
    case 'human.veto':
      return p['final'] === true
        ? `HUMAN REFUSED IT - ${field(p, 'note')}`
        : p['pending'] === true
          ? `held for a person - ${field(p, 'reasons')}`
          : `human veto - ${field(p, 'note')}`;
    case 'human.release':
      return `HUMAN LET IT THROUGH - ${field(p, 'note')}`;
    case 'human.override':
      return `human override - ${field(p, 'note')}`;
    case 'webhook.received':
      return `processor says ${field(p, 'eventType')} about ${shortKey(field(p, 'resourceId'))}`;
    default:
      return `${message.type} ${JSON.stringify(p).slice(0, 90)}`;
  }
}

export default function Tape({
  messages,
  findings,
  currency,
  selectedSeq,
  onSelect,
}: {
  messages: readonly SealedMessage[];
  findings: readonly Finding[];
  currency: CurrencyCode;
  selectedSeq: number | null;
  onSelect: (message: SealedMessage) => void;
}): React.ReactElement {
  const broken = new Map<number, Finding[]>();
  for (const finding of findings) {
    const list = broken.get(finding.seq) ?? [];
    list.push(finding);
    broken.set(finding.seq, list);
  }

  return (
    <div className="brass-edge flex h-full min-h-0 flex-col rounded-lg bg-ink/70">
      <div className="flex items-baseline justify-between border-b border-white/10 px-4 py-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">The tape</h3>
        <span className="font-mono text-[11px] text-white/40">{messages.length} sealed</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px] leading-[1.55]">
        {messages.map((message) => {
          const tone = TONE_OF[message.type] ?? 'quiet';
          const trouble = broken.get(message.seq);
          return (
            <li key={message.seq}>
              <button
                type="button"
                onClick={() => onSelect(message)}
                className={`tape-in flex w-full gap-2 px-4 py-1 text-left transition hover:bg-white/5 ${
                  selectedSeq === message.seq ? 'bg-brass/10' : ''
                }`}
              >
                <span className="w-10 shrink-0 text-white/25 tnum">{message.seq}</span>
                <span className="w-16 shrink-0 text-white/25">{clockOf(message.ts)}</span>
                <span className="w-4 shrink-0" style={{ color: COLOUR[tone] }}>
                  {GLYPH[message.type] ?? '·'}
                </span>
                <span className="w-24 shrink-0 truncate text-white/40" title={message.actor}>
                  {message.actor}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: COLOUR[tone] }} title={gist(message, currency)}>
                  {gist(message, currency)}
                </span>
                {trouble ? (
                  <span className="shrink-0 text-alarm" title={trouble.map((finding) => `${finding.code}: ${finding.detail}`).join(' / ')}>
                    {trouble.length} fault(s)
                  </span>
                ) : (
                  <span className="w-16 shrink-0 text-right text-white/15">{message.bodyHash.slice(0, 8)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
