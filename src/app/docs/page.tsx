import { DEFAULT_FEE_SCHEDULE } from '../../core/books';
import {
  AUTO_SETTLE_LIMIT_MINOR,
  FIRST_PAIRING_REVIEW_MINOR,
  MIN_REPUTATION_BPS,
  SESSION_EXPOSURE_CAP_MINOR,
  STRAY_PRICE_BPS,
} from '../../core/settlement';
import { cash } from '../ui/format';
import { spokenBy } from '../../server/interpreter';

export const dynamic = 'force-dynamic';

/**
 * How the floor works, written for somebody who has never seen it run.
 *
 * Every number on this page is imported from the module the engine actually executes, so the
 * explanation cannot drift away from the behaviour while you read it. The thresholds are the ones a
 * live floor holds itself to right now, in the currency the pit settles in.
 */

const STATIONS: readonly { readonly where: string; readonly head: string; readonly body: string; readonly tone: string }[] = [
  {
    where: 'core/world.ts',
    head: 'The seats',
    body: 'Once the instruments are picked, the seed shuffles the houses into the pits, sets the opening print of each pit, and gives every seat a strategy, a reputation and a stack of money. The same seed on another machine seats the same houses with the same intentions - that is what makes a run reproducible rather than a story.',
    tone: 'text-buy',
  },
  {
    where: 'core/policy.ts',
    head: 'The shouts',
    body: 'One seat speaks per round. Its policy reads the book and its own state, then decides whether to bid, offer, hit the tape, or walk away. Every shout is signed by that seat before the clerk sees it, so a word said on the floor cannot be quietly rewritten afterwards.',
    tone: 'text-buy',
  },
  {
    where: 'core/book.ts',
    head: 'The crossed book',
    body: 'A central limit order book, price-time priority, resting limits and immediate-or-cancel market orders alike. It matches whatever crosses, and it never refuses a trade for being too big or too odd - that is not a call the book gets to make.',
    tone: 'text-paper',
  },
  {
    where: 'core/ledger.ts',
    head: 'The books',
    body: 'A print is only a promise until money moves. Escrow is funded as a debit and a credit, the fee is booked when the capture lands, the payout clears against the seller, and a refund walks the same postings in reverse. The trial balance has to tie at every step or the floor stops.',
    tone: 'text-paper-2',
  },
  {
    where: 'core/settlement.ts',
    head: 'The hold',
    body: 'Before capture, a set of rules reads the ticket. Anything they catch is put on the human pile with the reason written in plain words - not "held by rule concentration" but the actual size, the actual counterparty. Nothing above the line settles without a person signing.',
    tone: 'text-brass',
  },
  {
    where: 'core/protocol.ts',
    head: 'The tape',
    body: 'Every message - each shout, print, hold, release, capture, refund - is canonicalised, signed with Ed25519, and sealed into a hash chain. One character changed anywhere in the middle breaks that seal and every seal after it, which is the only proof a settlement needs.',
    tone: 'text-flag',
  },
  {
    where: 'gateway/paypal.ts',
    head: 'The processor',
    body: 'One interface, two bodies behind it: a local processor that behaves like PayPal well enough to run the whole floor with no credentials, and the real sandbox, which mints orders, waits for a buyer, captures, voids, refunds and pays out. The floor cannot tell them apart except by the mode string.',
    tone: 'text-sell',
  },
  {
    where: 'gateway/paypal.ts',
    head: 'The webhook',
    body: 'The processor tells us what it did on its own schedule. Every event is verified against its signature before it is believed, attributed to the trade it names, and put on the tape as it arrived. An event nobody can attribute is still recorded - a floor should say out loud what it could not place.',
    tone: 'text-sell',
  },
];

const RULES: readonly { readonly label: string; readonly line: string; readonly note: string }[] = [
  {
    label: 'Auto-settle limit',
    line: cash(AUTO_SETTLE_LIMIT_MINOR, 'USD'),
    note: 'A ticket at or under this settles on the authority of the book alone. Above it, a person decides.',
  },
  {
    label: 'Stray price',
    line: `${(STRAY_PRICE_BPS / 100).toFixed(1)}%`,
    note: 'A fill further than this from the last print is held - a market that jumped is a market worth looking at.',
  },
  {
    label: 'Standing in the pit',
    line: `${MIN_REPUTATION_BPS} bps`,
    note: 'A house rated under this cannot settle without review, however small the ticket.',
  },
  {
    label: 'Session exposure',
    line: cash(SESSION_EXPOSURE_CAP_MINOR, 'USD'),
    note: 'What one account may take in a session before the floor asks whether it should.',
  },
  {
    label: 'First pairing',
    line: cash(FIRST_PAIRING_REVIEW_MINOR, 'USD'),
    note: 'Two strangers settling this much for the first time get looked at; most trades on a floor are between strangers.',
  },
  {
    label: 'Fee',
    line: `${(DEFAULT_FEE_SCHEDULE.bps / 100).toFixed(2)}% + ${cash(DEFAULT_FEE_SCHEDULE.fixedMinor, 'USD')}`,
    note: 'Booked as its own posting at capture, so a gross amount and a net one are never the same number in two places.',
  },
];

const VOICES = [
  {
    head: 'A hosted model',
    body: 'AI_BASE_URL, AI_API_KEY and AI_MODEL point the room at any OpenAI-compatible chat endpoint. All three or none: a base and a key without a named model would answer with a default the screen cannot name.',
  },
  {
    head: 'A model on this machine',
    body: 'With no endpoint configured the floor asks a local Ollama server what it holds and takes the smallest completion-capable model installed. A laptop with `ollama serve` running is a talking floor with nothing pasted into it.',
  },
  {
    head: 'The desk template',
    body: 'Deterministic prose built from the same facts, in the same words the card already shows. This is what a fresh clone, the test suite and any public demo speak — and a chit never goes blank because a model was unreachable.',
  },
];

export default async function DocsPage(): Promise<React.ReactElement> {
  const voice = await spokenBy();
  return (
    <div className="mx-auto max-w-[980px] pt-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass">how it works</p>
      <h1 className="mt-3 font-display text-[42px] leading-[1.08] text-paper">
        A trading floor where the traders are programs
        <br />
        and the bell is a person.
      </h1>
      <p className="mt-4 max-w-[720px] text-[15px] leading-relaxed text-white/60">
        Crier runs an open-outcry pit: agents shout bids and offers, a matching engine prints what crosses, a double-entry ledger moves the
        money, and every word is signed and chained. What it does not do is let any of that settle without somebody accountable for it. The
        human is not a control bolted on at the end - the hold pile is the centre of the room.
      </p>

      <div className="mt-10 flex items-center gap-3">
        <span className="font-display text-[19px] text-brass">A trade, start to finish</span>
        <span className="h-px flex-1 bg-brass/25" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {STATIONS.map((station, index) => (
          <article key={station.head} className="brass-edge rounded-lg bg-felt/55 p-4">
            <div className="flex items-baseline gap-3">
              <span className={`font-display text-[26px] leading-none ${station.tone}`}>{String(index + 1).padStart(2, '0')}</span>
              <h2 className="font-display text-[17px] text-paper">{station.head}</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-white/60">{station.body}</p>
            <code className="mt-3 inline-block rounded bg-black/40 px-2 py-1 font-mono text-[10.5px] text-white/45">{station.where}</code>
          </article>
        ))}
      </div>

      <div className="mt-12 flex items-center gap-3">
        <span className="font-display text-[19px] text-brass">What the floor holds itself to</span>
        <span className="h-px flex-1 bg-brass/25" />
      </div>
      <p className="mt-2 text-[13px] text-white/45">
        Read from the module that enforces them, in US dollars - the pit would print them in its own currency. Change them and the sealed
        record says so.
      </p>
      <ul className="mt-3 divide-y divide-white/8 rounded-lg border border-white/8 bg-felt/45">
        {RULES.map((rule) => (
          <li key={rule.label} className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,190px)_minmax(0,140px)_minmax(0,1fr)]">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">{rule.label}</span>
            <span className="font-mono text-[15px] text-brass tnum">{rule.line}</span>
            <span className="text-[12.5px] leading-snug text-white/55">{rule.note}</span>
          </li>
        ))}
      </ul>

      <div className="mt-12 flex items-center gap-3">
        <span className="font-display text-[19px] text-brass">The interpreter</span>
        <span className="h-px flex-1 bg-brass/25" />
      </div>
      <p className="mt-3 max-w-[720px] text-[13.5px] leading-relaxed text-white/60">
        The engine speaks in minor units and rule ids; a person on the pile reads sentences. When a settlement stops, the chit can be read out
        in plain English by the floor's interpreter — a language model when one answers on this machine, and a fixed template when none does.
        The card says which of the two wrote it, because somebody is about to sign a decision off those words.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {VOICES.map((voice) => (
          <article key={voice.head} className="brass-edge rounded-lg bg-felt/45 p-4">
            <h2 className="font-display text-[15px] text-paper">{voice.head}</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/55">{voice.body}</p>
          </article>
        ))}
      </div>
      <p className="mt-3 max-w-[720px] text-[13px] leading-relaxed text-white/45">
        <span className="text-brass">This machine is read by:</span> <span className="font-mono text-white/70">{voice.spokenBy}</span>. What no
        channel gets to do is touch a number: the model is handed the amounts the engine already decided and asked to talk about them, it sets
        no price and approves nothing, and its prose is never sealed into the tape. A brief that contradicts the card loses.
      </p>

      <div className="mt-12 flex items-center gap-3">
        <span className="font-display text-[19px] text-brass">Check it without trusting us</span>
        <span className="h-px flex-1 bg-brass/25" />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <p className="text-[13.5px] leading-relaxed text-white/60">
          The tape is the record. Take it from the audit room — or write it out with <code className="text-white/70">--json</code> — and you
          hold every shout, print, hold, signature and posting the session produced; nothing about the run lives only in this process. A
          stranger with the file, and no access to the machine that made it, can re-derive the balances from the postings, floor every account
          against the ledger, and walk the chain using only the public keys visible inside it.
        </p>
        <div className="rounded-lg bg-black/45 p-4 font-mono text-[12px] leading-relaxed text-white/70">
          <div className="text-white/40"># play a session and keep its tape</div>
          <div>npm run pit -- --seed opening-bell --ticks 12 --json tape.json</div>
          <div className="mt-3 text-white/40"># audit that recording, trusting nothing it says about itself</div>
          <div>npm run audit:ledger -- --file tape.json</div>
          <div className="mt-3 text-white/40"># or watch it on a screen</div>
          <div>npm install &amp;&amp; npm run dev</div>
        </div>
      </div>

      <div className="mt-12 flex items-center gap-3">
        <span className="font-display text-[19px] text-brass">The surface</span>
        <span className="h-px flex-1 bg-brass/25" />
      </div>
      <ul className="mt-3 space-y-1.5 font-mono text-[12px]">
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">GET /api/floor</span>
          <span className="text-white/55">the rooms open on this machine, and the instrument board a door may pick from</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">POST /api/floor</span>
          <span className="text-white/55">open a floor from a seed, or take the one that seed already opened</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">GET /api/floor/&#123;id&#125;</span>
          <span className="text-white/55">the whole room; <span className="text-white/70">?since=&lt;seq&gt;</span> trims only the tape, and a pointer in the query — <span className="text-white/70">?seed=…&amp;instruments=…&amp;ticks=…&amp;round=…</span> — replays the room on a machine that never saw it</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">POST /api/floor/&#123;id&#125;</span>
          <span className="text-white/55">one round, run to the bell, close, and the human actions on a settlement — the same pointer in the body rebuilds the room first, and once <span className="text-white/70">OPERATOR_TOKEN</span> is set the ones that speak for the platform need it in an <span className="text-white/70">x-operator-token</span> header</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">GET /api/floor/&#123;id&#125;/tape</span>
          <span className="text-white/55">the whole recording as a file, in the format the auditor reads — pointer in the query included, so a tape can be taken from any machine</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-buy">GET /api/floor/&#123;id&#125;/chit</span>
          <span className="text-white/55">one held settlement read out loud — <span className="text-white/70">?trade=&lt;id&gt;</span> and a pointer, and the answer names the channel that wrote it</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-sell">POST /api/webhooks/paypal</span>
          <span className="text-white/55">verified processor events, attributed to a trade or recorded as unplaceable</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-brass">/floor/&#123;id&#125;</span>
          <span className="text-white/55">the pit: the ring, the board, the pile, the tape</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-brass">/audit</span>
          <span className="text-white/55">the journal, the trial balance, the chain report and a scrubber through the session</span>
        </li>
        <li className="flex flex-wrap gap-x-3">
          <span className="w-[190px] shrink-0 text-brass">/checkout/return &middot; /checkout/cancel</span>
          <span className="text-white/55">where the processor sends a buyer back to; it reports the state and settles nothing</span>
        </li>
      </ul>

      <p className="mt-10 max-w-[720px] text-[13px] leading-relaxed text-white/40">
        Talking to the real processor needs credentials in the environment - a client id and secret, and a webhook id if you want events
        believed rather than refused. Without them the floor runs on the local processor and every screen, rule and posting behaves the same.
      </p>

      <div className="mt-8 flex flex-wrap gap-5 font-mono text-[12.5px]">
        <a className="rounded bg-brass px-4 py-2 text-ink no-underline hover:bg-[#eab94f]" href="/">
          open a floor
        </a>
        <a className="self-center text-white/55 no-underline hover:text-brass" href="/audit">
          the audit room
        </a>
      </div>
    </div>
  );
}
