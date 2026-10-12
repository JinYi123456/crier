# The Crier protocol

Version 1. This document specifies what a Crier tape contains, how each line is sealed, and how to
convince yourself that a tape you were handed has not been edited — without access to the machine
that wrote it and without trusting a single word of what it says about itself.

Everything here is derived from `src/core/`. Where this page and the code disagree, the code is the
protocol and this page is the bug.

---

## 1. Identifiers

Every id in the system is a hash of what it describes and never a random draw, so two honest
replays of the same session produce the same identifiers and can be diffed line for line. Where two
book orders are identical in every respect, the book's own order index breaks the tie.

| Id | Rule |
| --- | --- |
| Session | `crier_` + `sha256("crier/run\|<seed>\|<instruments>\|<agentsPerSide>\|<maxTicks>")` truncated to 16 hex |
| Actor | A short name: `exchange`, `human`, or `<role>-<house>-<n>-<symbol>` — e.g. `buy-sable-2-cac` |
| Public key | `sha256("crier/identity/v1\|<seed>\|<actor>")` used as the Ed25519 seed |
| Book order | `ord_` + first 20 hex of `sha256(instrument\|party\|side\|ts\|price\|qty\|orderIndex)` |
| Fill | `fill_` + first 20 hex of `sha256(takerOrderId\|makerOrderId\|qty)` |
| Trade | `trade_` + first 20 hex of `sha256(session\|fillId)` |
| Ledger entry | `entry_` + first 20 hex of `sha256(idempotencyKey\|seq)` |

The generic form is `derivedId(prefix, …parts)` in `core/canonical.ts`: join the parts with `|`,
SHA-256, take the first 20 hex characters.

A seed must be at least 4 characters. A session's clock starts at a fixed instant and steps forward
with each sealed message; it never reads the wall clock, which is what lets a replay match.

## 2. Money

Amounts are integers counting the smallest unit of a currency (`2500` is `$25.00`). 36 currencies
are known, each with its minor-unit exponent: JPY and KRW have no minor unit, and seven — KWD, BHD,
OMR, JOD, TND, IQD and LYD — divide into thousandths rather than hundredths.

- No amount is ever held in a floating point value.
- An amount above `Number.MAX_SAFE_INTEGER` is a hard error, not a rounding accident.
- Percentages are basis points, so `299` is 2.99%.
- **No signed string contains a formatted number.** Prose that ends up inside a sealed payload
  never carries a currency symbol, a thousands separator, or a bare minor-unit count: those bytes
  are the same on every machine, but a `$2,500.00` in prose would make the hash depend on whose
  locale produced it. Amounts live in numeric payload fields and the screen formats them.

## 3. Canonical JSON

A signature covers bytes, so the bytes have to be derivable from the value. `canonicalJson` in
`core/canonical.ts`:

1. Object keys are sorted with JavaScript's default string ordering.
2. Only `null`, booleans, strings, arrays and plain objects may appear. A prototype other than
   `Object.prototype` or `null` is refused.
3. Numbers must be finite **and** safe integers. A float, `NaN`, `Infinity` or a `bigint` throws —
   a value that cannot be represented exactly is a bug to be heard about, not a rounding difference
   to be chased later.
4. `undefined` members are dropped rather than serialised as `null`.
5. Strings are escaped as `JSON.stringify` escapes them.

## 4. Identities and signatures

Each actor holds an **Ed25519** key pair. The private seed is derived from the session seed (§1),
which is what makes a recorded session replayable and a replay byte-comparable between machines.
The public key is the raw 32 bytes, hex encoded, and is carried in every message as `key`.

Signatures are over the UTF-8 bytes of a hex string, and are themselves hex (128 characters). A
signature that is not 64 bytes of hex fails verification rather than throwing — an auditor has to
be able to explain a damaged tape, not crash on it.

## 5. The chain

A sealed message is a body, a link and a seal. Keys and hashes are elided in the middle of this real
line 0 so it fits on a page:

```jsonc
{
  "v": 1, "seq": 0, "session": "crier_98dee60fe4cdb599", "ts": 1791900000120,
  "actor": "exchange", "key": "8a712d1f572d55df…3bd067a", "type": "market.open",
  "payload": { "session": "crier_98dee60fe4cdb599", "seed": "shots-42339", "currency": "USD",
               "catalog": "9b3d468761ee2336", "feed": "bundled",
               "instruments": "coffee-green@45100,cacao-fine@23425", "houses": 16, "maxTicks": 10 },
  "prevHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "bodyHash": "ba9caa9a3ffa4b2d…77a93250",
  "sig": "7ce6544eebe606f1…06f1aea4a8fc4c24"
}
```

Three hashes, each with its own job:

```
bodyHash  = sha256(canonicalJson(body))
            body = { v, seq, session, ts, actor, key, type, payload }   // note: not prevHash

signingInput = sha256(prevHash + "|" + bodyHash)
sig          = Ed25519.sign(signingInput, actor's private key)

sealHash    = sha256(canonicalJson({ bodyHash, sig, seq }))
            // the successor's prevHash is its predecessor's sealHash
```

`GENESIS_HASH` is 64 zeros and is the `prevHash` of line 0. `seq` starts at 0 and increments by 1.

The reason for a seal hash as well as a body hash: `bodyHash` says *what was said*, `sealHash` says
*what was said, by whom, in this position*. A successor links to `sealHash`, not `bodyHash`, so a
message lifted from another branch — same content, same valid signature, different predecessor —
still fails. And because `sealHash` is built from the recomputed `bodyHash` rather than the
`bodyHash` the line claims, editing one message breaks every seal after it as well as its own; the
damage cannot be confined to the line that was touched.

## 6. Message types

`actor` is who signs. `exchange` is the platform's own principal; `human` is the named operator.
Everything in the settlement and human tables carries `tradeId` in its payload; the floor-wide
`market.*`, `book.*` and `floor.*` types do not.

### The floor

| Type | Actor | Payload |
| --- | --- | --- |
| `market.open` | exchange | `session, seed, currency, catalog, feed, instruments, houses, maxTicks` |
| `book.order` (reference) | exchange | `instrument, openingMinor, tickSizeMinor, lot, reference: true` |
| `floor.quote` | the shouting party | `instrument, party, side, priceMinor, qty, kind, reason, voice, urgencyBps` |
| `book.order` | the shouting party | `instrument, order, party, side, priceMinor, qty, kind, resting, rejected, expiredQty` |
| `book.cancel` | the cancelling party | `instrument, party, orders` |
| `book.match` | the aggressor | `instrument, fill, priceMinor, qty, buyer, seller, aggressor, maker, buyOrder, sellOrder` |
| `floor.accept` | the resting party | `instrument, fill, priceMinor, party, voice` |
| `floor.walk_away` | the departing party | `instrument, party, reason` |
| `market.close` | exchange | `session, ticks, trades, grossMinor, feeMinor, refundedMinor, heldTrades, headHash` |

`voice` is the seat's own words: `<name> bids`, `<name> offers`, `<name> hits` or `<name> takes` on
a shout, and the single word `done` from a resting party that lets the crossing happen.
`reference: true` marks the opening quote a pit posts for price discovery, which is not a shout
anybody is standing behind.

### The settlement

| Type | Actor | Payload |
| --- | --- | --- |
| `order.created` | exchange | `tradeId, orderId, grossMinor, currency, instrument, buyer, seller, priceMinor, qty` |
| `order.approved` | exchange | `tradeId, orderId, grossMinor` |
| `order.captured` | exchange | `tradeId, orderId, captureId, grossMinor, feeMinor, netMinor, currency` |
| `order.voided` | exchange | `tradeId, orderId, grossMinor, reason` |
| `order.failed` | exchange | `tradeId, stage, …` — `stage` is `create`, `approve`, `payout` or `refund`, and the rest names what was being failed |
| `payout.created` | exchange | `tradeId, payoutId, recipient, amountMinor, currency` |
| `payout.paid` | exchange | `tradeId, payoutId, recipient, amountMinor, status` |
| `payment.refunded` | exchange | `tradeId, refundId, amountMinor, currency, reason, source, totalRefundedMinor` |
| `ledger.entry` | exchange | `tradeId, entryId, code, account, amountMinor, currency, memo` |
| `webhook.received` | exchange | `eventId, eventType, resourceId, tradeId, at` |

`source` on a refund is `escrow` while the money is still held, `settlement_bank` once the platform
is advancing it from its own cleared cash. `ledger.entry` mirrors a posting the books already
accepted, so the tape can be audited on its own; when a refund is partly absorbed by the platform
there is an extra one carrying `absorbed: true` and no `memo`.

### The human

| Type | Actor | Payload |
| --- | --- | --- |
| `human.veto` (pending) | exchange | `tradeId, pending: true, rules, reasons, grossMinor`, plus `approvalUrl` when the wait is the processor's rather than ours |
| `human.veto` (refused) | **human** | `tradeId, note, grossMinor, final: true` |
| `human.release` | **human** | `tradeId, note, grossMinor` |

A pending veto is the floor reporting its own doubt; a final veto and a release are decisions, and
they are signed with the operator's key. That distinction is the whole point: "a human approved
this" is a claim anybody can check against the key in the tape, rather than a line in a log the
platform wrote about itself.

## 7. The books

Chart of accounts (`core/books.ts`):

| Account | Type | Floor |
| --- | --- | --- |
| `asset:escrow` | asset | 0 |
| `asset:settlement_bank` | asset | 0 |
| `liability:due_to_buyer:<party>` | liability | 0 |
| `liability:due_to_seller:<party>` | liability | 0 |
| `revenue:transaction_fee` | revenue | — |
| `expense:chargeback_absorbed` | expense | — |
| `equity:opening_balance` | equity | — |

Every settlement phase is one entry, and every entry balances to the unit:

| Code | Debit | Credit |
| --- | --- | --- |
| `OPENING_BALANCE` | `settlement_bank` (the float) | `opening_balance` |
| `ESCROW_HOLD` | `escrow` gross | `due_to_buyer(buyer)` gross |
| `TRADE_CAPTURE` | `due_to_buyer(buyer)` gross | `due_to_seller(seller)` net, `transaction_fee` fee |
| `SELLER_PAYOUT` | `due_to_seller(seller)` net | `escrow` net |
| `PLATFORM_FEE` | `settlement_bank` fee | `escrow` fee |
| `REFUND_ISSUED` (claim) | `transaction_fee` reversal, `due_to_seller` what is still owed, `chargeback_absorbed` the shortfall | `due_to_buyer` refund |
| `REFUND_ISSUED` (cash) | `due_to_buyer` refund | `escrow` or `settlement_bank` refund |
| `ORDER_VOIDED` | `due_to_buyer` gross | `escrow` gross |

Fee: `ceil(gross × bps / 10000) + fixedMinor`, clamped to the gross. The default schedule is
299 bps plus 30 minor units.

The ledger refuses, rather than corrects:

- fewer than two postings, or two lines on the same account in one entry;
- a posting carrying both a debit and a credit, or neither;
- an entry whose debits and credits do not tie;
- a posting in a currency other than the account's;
- an entry that would take a floored account below its floor — **customer money cannot go negative
  to make a settlement fit**;
- reusing an idempotency key for a different entry. The same key and the same shape returns the
  entry that was already posted, which is what makes a retried settlement safe.

A refund is two entries posted inside one transaction, so a refusal on the second leaves the books
exactly as they were.

## 8. The hold

Capture is gated by five rules (`core/settlement.ts`). A rule returns a sentence or nothing; the
sentences are what the pile shows, and they are signed.

| Rule | Fires when | Default |
| --- | --- | --- |
| `size` | gross above the auto-settle limit | 250000 minor = $2,500.00 |
| `stray_price` | fill further than this from the last print on the instrument | 1500 bps = 15% |
| `unrated` | either side's standing is below this | 3000 bps = 30% |
| `first_pairing` | the pair has never settled and gross exceeds this | 100000 minor = $1,000.00 |
| `concentration` | this seller's session total would exceed the cap | 200000 minor = $2,000.00 |

A sixth value, `awaiting_approval`, is not a rule of ours. It is the processor saying the buyer
still has the payment page open, reported on the same pile, because a settlement waiting on a
person is the same kind of object either way.

The rules gate **capture**, not matching. Agents may shout anything and the book will cross it;
what a human decides is whether the platform moves money on the back of a print. That is the
honest position — the trade has already happened, the question is settlement.

## 9. Verification

`verifyChain(messages, keyring)` walks the tape and returns every break it finds. It never throws.
Nine findings, each a distinct way to lie:

| Code | What it means |
| --- | --- |
| `payload_not_canonical` | the payload holds a value that cannot be canonically represented, so the recorded hash is not reproducible |
| `body_hash_mismatch` | recomputing the body hash does not return what the line claims — the content was edited |
| `signature_invalid` | the signature does not verify against the key that is present |
| `unknown_actor` | no key is registered for this actor at all |
| `key_mismatch` | the line carries a key that is not the actor's registered one — a substituted identity |
| `sequence_gap` | `seq` jumped |
| `sequence_repeated` | `seq` went backwards or repeated — a replay of an earlier line |
| `chain_break` | `prevHash` does not quote the predecessor's seal — the line is detached, or a whole branch was spliced in |
| `clock_regression` | the line is stamped before its predecessor |

A keyring can be built from the public keys the tape itself carries — `keyringFrom` over
`messages[].key`, which is what the auditor does — so verification needs no out-of-band registry.
`verifiedUpToSeq` reports how far the chain held, which is what an audit screen shows when a tape is
damaged partway through.

One honest limit, and it is a real one. Because every private key here is derived from the session
seed (§1), and the seed is inside the recording so that a replay can be checked, anybody holding the
file can also re-derive the keys and forge the entire tape from scratch. That is the price of a
session being reproducible, and it is the right price for a floor that exists to be examined. A
deployment that needs the signatures to bind is a deployment that keeps the seeds: verification
stays the same, and only the ability to mint a rival tape goes away.

What the tape does prove, and proves without any registry, is that nobody edited it. A keyring read
off the tape cannot catch a substituted identity — the substitute becomes the registered key — but
`identityFromSeed(seed, actor)` can be recomputed and compared against `messages[].key`, which is
where `key_mismatch` earns its place.

## 10. The recording

A session's whole state is one JSON document — `SessionSnapshot` — and it is the format
`npm run audit:ledger -- --file` reads. It contains the accounts, every entry, every sealed message,
the trades, the participants with their public keys, and the summary. The audit room's **take the
tape** button writes exactly that document to a download.

An auditor who trusts none of it does this:

1. Re-derive every balance by summing `entries[].postings`, ignoring the numbers the snapshot
   prints. The debits and credits must tie to the unit.
2. Check each floored account against its own history: `asset:escrow` must never have gone
   negative at any prefix of the entry list.
3. Build the keyring from `messages[].key`, and run `verifyChain`.
4. Recompute each line's `sealHash` in sequence. The last of them is the `headHash` the snapshot
   reports; `market.close` quotes the one before it, because it reads the head and is then sealed
   onto it.
5. Re-open a `Session` on the local processor from the recording's own `seed`, the instruments in
   `markets[]`, the seats per side implied by `participants[]`, and `maxTicks` — and confirm it
   produces the same tape, byte for byte.

Steps 1 to 4 need nothing but the file. Step 5 needs the code, and is the strongest check there
is: it means the shouts were not merely signed, they were the shouts the seed contained.

## 11. Determinism

A run is a pure function of `seed`, `instrumentIds`, `agentsPerSide`, `maxTicks`, `currency` and
`payoutMode`, given the same price feed. Randomness comes from one seeded generator (`core/rng.ts`)
and nowhere else; the clock starts at a fixed instant and steps forward with each sealed message,
never with the wall; instrument openings come from a bundled snapshot unless a live feed is
configured on purpose.

This is what makes step 5 above possible, and it is why the protocol can insist that a signature
covers the same bytes on every machine.

## 12. Versioning

`v` is carried in every body and therefore inside every hash. `verifyChain` reports a line whose `v`
is not the version it speaks. Adding a message type is compatible; changing what `bodyOf` includes,
how keys are sorted, or what `sealHash` covers is not, and takes the number up.
