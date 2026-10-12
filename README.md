# Crier

**An open-outcry trading floor where the traders are programs, the money is somebody else's, and the bell is a person.**

Agents shout bids and offers at each other in a pit. A central limit order book prints whatever
crosses. A double-entry ledger moves the money through escrow, books a fee, and pays the seller.
Every shout, print, hold and release is signed and sealed into a hash chain as it happens. And any
settlement that a risk rule flags stops on a pile until a named human signs it through.

That last part is the reason the rest exists. Autonomous agents negotiating payments is easy; the
hard question is what a platform is allowed to do with the money it is holding while it watches
them. Crier's answer is that it may match, but it may not settle past a person.

```
npm install
npm run dev
```

Then open <http://localhost:3000> and press **Take the floor**. No credentials, no accounts, no
database — the whole thing runs on a seed and a deterministic local processor.

---

## What a run looks like

A floor is a function of its seed and the instruments it was opened on. The seed seats the houses,
gives each one a strategy, a reputation and a stack of money, sets the opening print in each pit,
and fixes every price they will go on to say. Give the same seed and the same instruments to two
machines and you get the same shouts, the same fills, the same postings and — byte for byte — the
same hashes.

Each round, one seat per pit speaks. It reads the book and its own state and decides whether to
bid, offer, hit the tape or walk away. Its shout is signed before the clerk sees it. If it crosses
the book, a fill is printed, and the fill becomes a settlement:

| Phase | What happens | On the books |
| --- | --- | --- |
| `matched` | the book prints a fill | nothing yet |
| `funded` | an order is opened and the buyer's money is held | escrow debit, buyer-claim credit |
| `captured` | the processor takes the money, the fee is recognised | claim debited, seller payable and fee revenue credited |
| `paid_out` | the seller is paid, the fee swept | payable debited, escrow credited |
| `refunded` | the claim is rebuilt and the cash handed back | the capture in reverse, plus any loss the platform absorbs |

Before capture, five rules read the ticket — size, stray price, standing, first pairing, session
concentration. Anything they catch goes on the human pile with the reason written in words, and
stays there until somebody signs a release or a veto. The signature on that decision is the
operator's own key, not the platform's.

## The screens

| Route | What is on it |
| --- | --- |
| `/` | the door: pick a seed and instruments, or take the floor the default seed already opened |
| `/floor/{id}` | the pit — the seat ring, the crossed book, the human pile, the live tape |
| `/audit?floor={id}` | the audit room — the journal in a grid, the trial balance, the chain verdict, and a scrubber that replays the session up to any line |
| `/docs` | how it works, with every threshold read from the module that enforces it |
| `/checkout/return` | the chit a buyer lands on after the processor, saying what is and is not settled |
| `/checkout/cancel` | the same chit for a buyer who walked away |

The audit room is the point of the application rather than a page bolted on beside it. Scrub the
session back to line 200 and the trial balance is recomputed from the postings up to that line, so
the books you are reading are the books as of then. In the pit, open any line of the tape and press
**edit it on purpose**: the floor rewrites one value on a copy of its own record and runs the audit
over it, so you can watch that line's seal fail and every seal after it fail with it.

## Without a browser

```
# play a whole session in a terminal
npm run pit -- --seed opening-bell --ticks 12

# play it and keep the recording
npm run pit -- --seed opening-bell --ticks 12 --json tape.json

# audit that recording, trusting nothing it says about itself
npm run audit:ledger -- --file tape.json
```

The auditor re-derives every balance from the postings, checks the trial balance and each
account's floor, and walks the message chain using only the public keys visible inside the tape.
It does not open the ledger's own bookkeeping to do it, which is what makes it worth running. It
exits non-zero if anything fails.

**Take the tape** in the audit room writes the same document to a download, so the recording a
stranger checks is the one the screen is standing behind rather than a summary of it.

`--agents`, `--instruments`, `--currency` and `--payout batched` are also there. `npm run pit -- --help`
prints the whole list.

## Settling against a real processor

Copy `.env.example` to `.env`. The variables are all optional; unset means the floor runs on the
local processor, which behaves like PayPal well enough to exercise every screen, rule and posting.

```
GATEWAY=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_WEBHOOK_URL=https://your.host/api/webhooks/paypal
```

In `sandbox` mode the app refuses to start a floor without both credentials, and neither is ever
printed or committed. Under a live sandbox the buyer approves a real PayPal page, so a settlement
stops on `funded` until they do — which is reported on the pile as `awaiting_approval`, alongside
the rules the floor imposes itself.

Register the webhook in the PayPal dashboard against `PAYPAL_WEBHOOK_URL`. Every event is verified
against the processor's signature before a word of it reaches a settlement; an event that does not
verify is refused, and a verified event that belongs to no trade here is acknowledged anyway — the
processor retries anything it does not hear back from.

## How it is put together

```
src/core/       the engine. No filesystem, no network unless a live price feed is configured.
  rng.ts        seeded generator; the only source of "chance"
  money.ts      integer minor units, 36 currencies, no float arithmetic
  canonical.ts  canonical JSON: sorted keys, safe integers only
  keys.ts       Ed25519 identities derived from the seed
  protocol.ts   the signed, hash-chained tape and its verifier
  ledger.ts     double-entry book: posting rules, floors, idempotency, transactions
  books.ts      the platform's chart of accounts and every settlement entry
  catalog.ts    the bundled instrument snapshot
  book.ts       the central limit order book
  policy.ts     what a seat does when it is its turn to speak
  world.ts      seats the floor, runs the rounds, owns the tape
  settlement.ts match to money: escrow, capture, fee, payout, refund, and the veto layer

src/gateway/    the payment boundary. types.ts is the contract; sim.ts and paypal.ts are the two bodies.
src/server/     rooms, and the mapping from a refusal to an HTTP status.
src/app/        Next.js App Router: the screens and the JSON API.
tools/          the terminal pit, the ledger auditor, the language audit, the screenshot walk.
tests/          vitest, 157 tests over the engine and the gateway.
```

The engine is server-side only — it uses `node:crypto` and never runs in the browser. Client
components may import its types, and `core/money.ts` is the one module safe to use either way.

## Checking it

```
npm run verify
```

That is typecheck, the test suite, the language audit and a production build, in that order.
`npm run test:e2e` adds the Playwright pass over the live screens.

The language audit is not a joke lint. Everything shipped has to be English, and the check walks
every source file for prose in another script and for sentences that belong in a private note
rather than in a product. It runs inside `npm run lint`, and inside `npm run verify`, so it cannot
be skipped by forgetting it.

## What this is not

- **Not durable.** Rooms live in the process that opened them. A restart closes the floor. The
  recording is a single JSON document — **take the tape** in the audit room, or `--json` from the
  terminal — so a session is kept by writing it out, not by pointing this at a database.
- **Not an operator console.** The human pile is one floor's pile. There are no roles, no
  audit trail on the operator's own login, and no authentication on the mutation endpoints yet —
  run this behind something, or only on your own machine.
- **Not a price forecast.** The agents have strategies, not alpha. The prices come from a seeded
  random walk off a bundled snapshot.

## Protocol

The wire format is documented in [PROTOCOL.md](PROTOCOL.md): the canonicalisation rules, the two
hashes per message and what each covers, every message type and its payload, the posting table for
each settlement phase, the veto thresholds, and how to verify a tape you were handed without
trusting whoever handed it to you.

## License

MIT — see [LICENSE](LICENSE).
