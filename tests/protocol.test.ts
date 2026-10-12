import { describe, expect, it } from 'vitest';
import { canonicalJson, derivedId, fingerprint, hashOf } from '../src/core/canonical';
import { identityFromPublicKeyHex, identityFromSeed, signHex, verifyHex } from '../src/core/keys';
import {
  GENESIS_HASH,
  append,
  computeBodyHash,
  computeSealHash,
  draftFor,
  keyringFrom,
  newChain,
  signingInput,
  verifyChain,
  type SealedMessage,
} from '../src/core/protocol';

const T0 = 1_700_000_000_000;
const SESSION = 'sess_test';

const exchange = identityFromSeed('seed-alpha', 'exchange');
const kestrel = identityFromSeed('seed-alpha', 'buyer-kestrel');
const onyx = identityFromSeed('seed-alpha', 'seller-onyx');
const keyring = keyringFrom([exchange, kestrel, onyx]);

function honestChain(count = 6) {
  const chain = newChain();
  append(chain, SESSION, exchange, 'market.open', { session: SESSION, tick_ms: 900 }, T0);
  for (let i = 0; i < count; i += 1) {
    const speaker = i % 2 === 0 ? kestrel : onyx;
    append(chain, SESSION, speaker, 'floor.quote', { round: i, price_minor: 100_000 - i * 500 }, T0 + (i + 1) * 1_000);
  }
  append(chain, SESSION, exchange, 'book.match', { trade_id: 'trade-1', qty: 2 }, T0 + 9_000);
  return chain;
}

describe('canonical form', () => {
  it('sorts keys at every depth so two objects that read differently hash the same', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(hashOf({ x: 1, y: [1, 2] })).toBe(hashOf({ y: [1, 2], x: 1 }));
  });

  it('refuses floats and non-plain objects rather than silently rounding them', () => {
    expect(() => canonicalJson({ amount: 12.5 })).toThrow(/safe integer/);
    expect(() => canonicalJson({ when: new Date(0) })).toThrow(/plain objects|unsupported/);
    expect(() => canonicalJson({ huge: 2n ** 70n })).toThrow(/bigint/);
  });

  it('derives stable ids and readable fingerprints', () => {
    expect(derivedId('entry', 'a', 1)).toBe(derivedId('entry', 'a', 1));
    expect(derivedId('entry', 'a', 2)).not.toBe(derivedId('entry', 'a', 1));
    expect(fingerprint('0123456789abcdef0123456789abcdef')).toBe('0123 4567 89ab cdef 0123 4567 89ab cdef');
  });
});

describe('ed25519 identities', () => {
  it('rebuilds the same keypair from the same seed and a different one from a different seed', () => {
    expect(identityFromSeed('seed-alpha', 'buyer-kestrel').publicKey).toBe(kestrel.publicKey);
    expect(identityFromSeed('seed-beta', 'buyer-kestrel').publicKey).not.toBe(kestrel.publicKey);
  });

  it('signs something another process can verify with only the public key', () => {
    const message = 'the bell rang at 09:00';
    const sig = signHex(message, onyx.privateKey);
    const viewer = identityFromPublicKeyHex('observer', onyx.publicKey);
    expect(verifyHex(sig, message, viewer.publicKeyObject)).toBe(true);
    expect(verifyHex(sig, message + ' ', viewer.publicKeyObject)).toBe(false);
    expect(verifyHex(sig.slice(0, 62), message, viewer.publicKeyObject)).toBe(false);
    expect(verifyHex('not-hex', message, viewer.publicKeyObject)).toBe(false);
  });
});

describe('the signed chain', () => {
  it('verifies an honest session end to end', () => {
    const chain = honestChain();
    const result = verifyChain(chain.messages, keyring);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(chain.messages.length);
    expect(result.verifiedUpToSeq).toBe(chain.messages.length - 1);
    expect(chain.messages[0]?.prevHash).toBe(GENESIS_HASH);
  });

  it('is reproducible: the same seed and script produce a byte-identical log', () => {
    const a = honestChain();
    const b = honestChain();
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(a.headHash).toBe(b.headHash);
  });

  it('notices a word changed deep in the log, and the break propagates to its successor', () => {
    const chain = honestChain();
    const tampered = chain.messages.map((m, i) =>
      i === 3 ? ({ ...m, payload: { ...m.payload, price_minor: 999_999 } } as SealedMessage) : m,
    );
    const result = verifyChain(tampered, keyring);
    expect(result.ok).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('body_hash_mismatch');
    expect(codes).toContain('chain_break');
    expect(result.findings.find((f) => f.code === 'body_hash_mismatch')?.seq).toBe(3);
    expect(result.verifiedUpToSeq).toBe(2);
  });

  it('names a line the canonical form refuses rather than crashing on it', () => {
    const chain = honestChain();
    const damaged = chain.messages.map((m, i) => (i === 2 ? ({ ...m, payload: { ...m.payload, qty: 1.5 } } as SealedMessage) : m));
    const result = verifyChain(damaged, keyring);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('payload_not_canonical');
    expect(codes).toContain('chain_break');
    expect(result.findings.find((f) => f.code === 'payload_not_canonical')?.seq).toBe(2);
    expect(result.verifiedUpToSeq).toBe(1);
  });

  it('notices a message that was deleted', () => {
    const chain = honestChain();
    const cut = chain.messages.filter((_, i) => i !== 4);
    const result = verifyChain(cut, keyring);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('sequence_gap');
    expect(codes).toContain('chain_break');
  });

  it('notices two messages that were swapped', () => {
    const chain = honestChain();
    const swapped = [...chain.messages];
    const left = swapped[2] as SealedMessage;
    const right = swapped[3] as SealedMessage;
    swapped[2] = right;
    swapped[3] = left;
    const result = verifyChain(swapped, keyring);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['chain_break']));
  });

  it('refuses to let a message from another branch be dropped in, even with a valid signature', () => {
    const honest = honestChain();
    const rival = newChain();
    append(rival, SESSION, exchange, 'market.open', { session: SESSION, tick_ms: 900 }, T0);
    const forked = append(rival, SESSION, kestrel, 'floor.quote', { round: 99, price_minor: 1 }, T0 + 50_000);
    const spliced = [...honest.messages.slice(0, 5), forked, ...honest.messages.slice(5)];
    const result = verifyChain(spliced, keyring);
    const at = result.findings.filter((f) => f.seq === forked.seq).map((f) => f.code);
    expect(at).toContain('chain_break');
    expect(at).toContain('sequence_repeated');
  });

  it('catches a forged quote signed with somebody else’s key', () => {
    const chain = honestChain();
    const draft = draftFor(
      { session: SESSION, actor: onyx, now: T0 + 20_000, prevHash: chain.headHash, seq: chain.seq },
      'floor.accept',
      { round: 6, price_minor: 90_000 },
    );
    // The attacker holds the buyer's key and claims the seller said this.
    const forged: SealedMessage = { ...draft, bodyHash: computeBodyHash(draft), sig: signHex(signingInput(draft), kestrel.privateKey) };
    const result = verifyChain([...chain.messages, forged], keyring);
    expect(result.findings.map((f) => f.code)).toContain('signature_invalid');
    expect(verifyHex(forged.sig, signingInput(draft), kestrel.publicKeyObject)).toBe(true);
  });

  it('flags an actor with no registered key, and a key that was rotated away', () => {
    const chain = honestChain();
    const stranger = identityFromSeed('seed-alpha', 'buyer-nobody');
    const strangerMessage: SealedMessage = { ...chain.messages[1]!, actor: 'buyer-nobody', key: stranger.publicKey };
    const result = verifyChain([chain.messages[0]!, strangerMessage], keyringFrom([exchange, kestrel]));
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('unknown_actor');

    const otherKey = identityFromSeed('seed-omega', 'buyer-kestrel');
    const replaced: SealedMessage = { ...chain.messages[1]!, key: otherKey.publicKey };
    const rotated = verifyChain([chain.messages[0]!, replaced], keyring);
    expect(rotated.findings.map((f) => f.code)).toContain('key_mismatch');
  });

  it('reports a clock that ran backwards', () => {
    const chain = honestChain();
    const warped: SealedMessage = { ...chain.messages[5]!, ts: T0 - 10 };
    const result = verifyChain([...chain.messages.slice(0, 5), warped, ...chain.messages.slice(6)], keyring);
    expect(result.findings.map((f) => f.code)).toContain('clock_regression');
  });

  it('binds the signature into the next link, so a re-signed message still breaks the chain', () => {
    const chain = honestChain();
    const target = chain.messages[2]!;
    const resealed: SealedMessage = { ...target, sig: target.sig.slice(0, 62) + (target.sig.endsWith('a') ? 'b' : 'a') };
    const messages = chain.messages.map((m, i) => (i === 2 ? resealed : m));
    const result = verifyChain(messages, keyring);
    expect(result.findings.map((f) => f.code)).toContain('signature_invalid');
    expect(computeSealHash(resealed)).not.toBe(computeSealHash(target));
  });
});
