import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { sha256Hex } from './canonical';

/**
 * Ed25519 identities for the parties that speak on the floor.
 *
 * Keys are derived from a single seed with a domain-separated hash, so a given seed
 * always produces the same principals: a recorded session can be replayed, re-verified
 * and diffed. The DER prefixes below are the fixed PKCS#8 / SPKI wrappers for an
 * Ed25519 key, which lets us build a key from raw bytes instead of shelling out to a
 * keygen tool.
 */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface Identity {
  readonly actor: string;
  /** 32-byte raw public key, hex encoded. This is what other parties see. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
  readonly publicKeyObject: KeyObject;
}

export function deriveSeed(masterSeed: string, actor: string): Buffer {
  return Buffer.from(sha256Hex(`crier/identity/v1|${masterSeed}|${actor}`), 'hex');
}

export function identityFromSeed(masterSeed: string, actor: string): Identity {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, deriveSeed(masterSeed, actor)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = publicKeyDer.subarray(publicKeyDer.length - 32);
  return {
    actor,
    publicKey: raw.toString('hex'),
    privateKey,
    publicKeyObject: createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    }),
  };
}

export function randomIdentity(actor: string): Identity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    actor,
    publicKey: der.subarray(der.length - 32).toString('hex'),
    privateKey,
    publicKeyObject: publicKey,
  };
}

export function identityFromPublicKeyHex(actor: string, publicKeyHex: string): Identity {
  return {
    actor,
    publicKey: publicKeyHex,
    privateKey: null as unknown as KeyObject,
    publicKeyObject: createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    }),
  };
}

export function signHex(message: string, privateKey: KeyObject): string {
  return nodeSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
}

export function verifyHex(signatureHex: string, message: string, publicKey: KeyObject): boolean {
  let sig: Buffer;
  let key = publicKey;
  try {
    sig = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  if (!/^[0-9a-f]*$/i.test(signatureHex)) return false;
  if (key.type !== 'public') key = createPublicKey(key);
  try {
    return nodeVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

export function publicKeyHexToObject(publicKeyHex: string): KeyObject {
  return identityFromPublicKeyHex('peer', publicKeyHex).publicKeyObject;
}
