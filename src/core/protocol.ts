import { canonicalJson, hashOf, sha256Hex } from './canonical';
import { identityFromPublicKeyHex, signHex, verifyHex, type Identity } from './keys';
import { type KeyObject } from 'node:crypto';

/**
 * The signed, hash-chained record of everything said on the floor.
 *
 * Each message seals the previous one into its own hash, so the log is a chain: edit a
 * word three hundred messages back and every seal after it stops verifying. Each message
 * is also signed by the party that spoke it, so "the exchange wrote this" is a claim that
 * can be checked against that party's key rather than taken on trust.
 *
 * Two hashes per message are deliberate:
 *   bodyHash  - what was said   (v, seq, session, ts, actor, key, type, payload)
 *   prevHash  - what came before (bodyHash + sig + seq of the previous message)
 * and the signature covers both, which is what stops a valid message being lifted from a
 * different branch and dropped in here.
 */

export const PROTOCOL_VERSION = 1;
export const GENESIS_HASH = '0'.repeat(64);

export type MessageType =
  | 'market.open'
  | 'market.close'
  | 'book.order'
  | 'book.cancel'
  | 'book.match'
  | 'floor.quote'
  | 'floor.accept'
  | 'floor.walk_away'
  | 'order.created'
  | 'order.approved'
  | 'order.captured'
  | 'order.voided'
  | 'order.failed'
  | 'payment.refunded'
  | 'payout.created'
  | 'payout.paid'
  | 'ledger.entry'
  | 'human.veto'
  | 'human.release'
  | 'human.override'
  | 'webhook.received';

export interface ChainBody {
  readonly v: number;
  readonly seq: number;
  readonly session: string;
  readonly ts: number;
  readonly actor: string;
  readonly key: string;
  readonly type: MessageType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DraftMessage extends ChainBody {
  readonly prevHash: string;
}

export interface SealedMessage extends ChainBody {
  readonly prevHash: string;
  readonly bodyHash: string;
  readonly sig: string;
}

export type FindingCode =
  | 'body_hash_mismatch'
  | 'signature_invalid'
  | 'chain_break'
  | 'sequence_gap'
  | 'sequence_repeated'
  | 'unknown_actor'
  | 'key_mismatch'
  | 'payload_not_canonical'
  | 'clock_regression';

export interface Finding {
  readonly index: number;
  readonly seq: number;
  readonly code: FindingCode;
  readonly detail: string;
}

export interface Keyring {
  readonly keys: ReadonlyMap<string, string>;
}

export function keyringFrom(identities: readonly Identity[]): Keyring {
  return { keys: new Map(identities.map((identity) => [identity.actor, identity.publicKey])) };
}

/** Everything a message *says*, without the link or the seal fields, in a fixed shape. */
export function bodyOf(message: ChainBody | DraftMessage | SealedMessage): ChainBody {
  return {
    v: message.v,
    seq: message.seq,
    session: message.session,
    ts: message.ts,
    actor: message.actor,
    key: message.key,
    type: message.type,
    payload: message.payload,
  };
}

export function computeBodyHash(message: ChainBody | DraftMessage | SealedMessage): string {
  return hashOf(bodyOf(message));
}

/**
 * The hash a successor must quote. It is derived from what the message *actually says*,
 * not from the bodyHash it claims, so editing one message breaks every seal that follows
 * it as well - the damage cannot be confined to the line that was touched.
 */
export function computeSealHash(message: SealedMessage): string {
  return sha256Hex(canonicalJson({ bodyHash: computeBodyHash(message), sig: message.sig, seq: message.seq }));
}

/** The exact bytes a signature is taken over: the body hash and the link before it. */
export function signingInput(message: DraftMessage): string {
  return sha256Hex(`${message.prevHash}|${computeBodyHash(message)}`);
}

export function seal(draft: DraftMessage, identity: Identity): SealedMessage {
  if (identity.actor !== draft.actor) throw new Error(`cannot sign for ${draft.actor} with the key of ${identity.actor}`);
  if (identity.publicKey !== draft.key) throw new Error(`draft key does not match identity ${draft.actor}`);
  if (!Number.isSafeInteger(draft.seq) || draft.seq < 0) throw new Error('seq must be a non-negative integer');
  const sig = signHex(signingInput(draft), identity.privateKey);
  return { ...draft, v: PROTOCOL_VERSION, bodyHash: computeBodyHash(draft), sig };
}

export function draftFor(
  context: { session: string; actor: Identity; now: number; prevHash: string; seq: number },
  type: MessageType,
  payload: Record<string, unknown>,
): DraftMessage {
  return {
    v: PROTOCOL_VERSION,
    seq: context.seq,
    session: context.session,
    ts: context.now,
    actor: context.actor.actor,
    key: context.actor.publicKey,
    type,
    payload,
    prevHash: context.prevHash,
  };
}

export interface ChainState {
  messages: SealedMessage[];
  headHash: string;
  seq: number;
}

export function newChain(): ChainState {
  return { messages: [], headHash: GENESIS_HASH, seq: 0 };
}

export function append(
  chain: ChainState,
  session: string,
  actor: Identity,
  type: MessageType,
  payload: Record<string, unknown>,
  now: number,
): SealedMessage {
  const message = seal(draftFor({ session, actor, now, prevHash: chain.headHash, seq: chain.seq }, type, payload), actor);
  chain.messages.push(message);
  chain.headHash = computeSealHash(message);
  chain.seq = message.seq + 1;
  return message;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly findings: Finding[];
  readonly count: number;
  /** Highest seq verified with no finding emitted so far; null if the first message failed. */
  readonly verifiedUpToSeq: number | null;
}

const keyCache = new Map<string, KeyObject | undefined>();

function publicKeyOf(publicKeyHex: string): KeyObject | undefined {
  if (keyCache.has(publicKeyHex)) return keyCache.get(publicKeyHex);
  let key: KeyObject | undefined;
  try {
    key = identityFromPublicKeyHex('peer', publicKeyHex).publicKeyObject;
  } catch {
    key = undefined;
  }
  keyCache.set(publicKeyHex, key);
  return key;
}

/**
 * Walk the chain and report every break. Total function - it never throws, because the
 * audit screen has to explain a damaged log instead of crashing on it.
 */
export function verifyChain(messages: readonly SealedMessage[], keyring: Keyring): VerificationResult {
  const findings: Finding[] = [];
  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 0;
  let lastTs = Number.NEGATIVE_INFINITY;
  let verifiedUpToSeq: number | null = null;
  let failedHere = false;

  messages.forEach((message, index) => {
    const push = (code: FindingCode, detail: string) => {
      findings.push({ index, seq: message.seq, code, detail });
      failedHere = true;
    };
    failedHere = false;

    try {
      canonicalJson(message.payload);
    } catch {
      push('payload_not_canonical', 'payload holds a value that cannot be canonically represented');
    }

    if (message.v !== PROTOCOL_VERSION) push('body_hash_mismatch', `protocol version ${message.v} is not ${PROTOCOL_VERSION}`);

    const registered = keyring.keys.get(message.actor);
    if (registered === undefined) push('unknown_actor', `${message.actor} holds no key in the keyring`);
    else if (registered !== message.key) {
      push('key_mismatch', `${message.actor} spoke with ${message.key.slice(0, 12)}…, but its registered key is ${registered.slice(0, 12)}…`);
    }

    if (computeBodyHash(message) !== message.bodyHash) {
      push('body_hash_mismatch', `${message.type} at seq ${message.seq} does not hash to the recorded bodyHash - its content was edited`);
    } else {
      const key = publicKeyOf(registered ?? message.key);
      if (!key) push('signature_invalid', 'no usable public key for this actor');
      else if (!verifyHex(message.sig, signingInput(message), key)) {
        push('signature_invalid', `${message.type} at seq ${message.seq} carries a signature that ${message.actor}'s key does not verify`);
      }
    }

    if (message.seq !== expectedSeq) {
      if (message.seq < expectedSeq) push('sequence_repeated', `seq ${message.seq} repeats or rewinds (expected ${expectedSeq})`);
      else push('sequence_gap', `seq jumped from ${expectedSeq - 1} to ${message.seq}`);
    }

    if (message.prevHash !== expectedPrevHash) {
      push('chain_break', `${message.type} at seq ${message.seq} does not quote the seal of its predecessor - it is detached from the chain`);
    }

    if (message.ts < lastTs) push('clock_regression', `${message.type} at seq ${message.seq} is stamped ${lastTs - message.ts}ms before its predecessor`);

    if (!failedHere && findings.length === 0) verifiedUpToSeq = message.seq;

    lastTs = Math.max(lastTs, message.ts);
    expectedSeq = Math.max(expectedSeq, message.seq) + 1;
    expectedPrevHash = computeSealHash(message);
  });

  return { ok: findings.length === 0, findings, count: messages.length, verifiedUpToSeq };
}

export function chainToJsonl(messages: readonly SealedMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

export function chainFromJsonl(text: string): SealedMessage[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SealedMessage);
}
