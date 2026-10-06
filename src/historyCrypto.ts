import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js';

import { decodeBase64UrlBytes, encodeBase64Url } from './transportCrypto';

// History crypto v1, byte-for-byte identical to the backend's
// `src/history_crypto.rs` and TodexCore's `HistoryCrypto.swift`, pinned by
// tests/fixtures/history-crypto-v1.json. Devices hold X-Wing (ML-KEM-768 +
// X25519) seeds; the backend wraps each segment's random DEK for every device
// public key and seals history content under that DEK.

export const HISTORY_CRYPTO_LABEL = 'todex-history-v1';
export const HISTORY_PUBLIC_KEY_LENGTH = 1216;
export const HISTORY_SECRET_KEY_LENGTH = 32;
export const HISTORY_KEM_CIPHERTEXT_LENGTH = 1120;
export const HISTORY_RECIPIENT_ID_LENGTH = 16;
export const HISTORY_KID_LENGTH = 16;
export const HISTORY_DEK_LENGTH = 32;
export const HISTORY_WRAPPED_DEK_LENGTH = HISTORY_DEK_LENGTH + 16;

/** Which record a content ciphertext belongs to; part of its nonce and AAD. */
export const HistoryContentStream = {
  EventSummary: 1,
  EventFull: 2,
  FrameSummary: 3,
  FrameFull: 4,
} as const;
export type HistoryContentStream = (typeof HistoryContentStream)[keyof typeof HistoryContentStream];

export type HistoryRecipientKeyPair = {
  /** The 32-byte X-Wing seed; never leaves the device. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
};

export type HistorySegmentKey = {
  kid: Uint8Array;
  dek: Uint8Array;
};

export type HistoryWrappedKey = {
  rid: Uint8Array;
  kemCt: Uint8Array;
  wrapped: Uint8Array;
};

/** JSON form of a wrapped key: base64url strings without padding. */
export type HistoryWrappedKeyJson = {
  rid: string;
  kemCt: string;
  wrapped: string;
};

const LABEL = utf8ToBytes(HISTORY_CRYPTO_LABEL);
const MAX_U64 = (1n << 64n) - 1n;

export function generateHistoryRecipientKeyPair(): HistoryRecipientKeyPair {
  return historyRecipientKeyPairFromSeed(randomBytes(HISTORY_SECRET_KEY_LENGTH));
}

export function historyRecipientKeyPairFromSeed(seed: Uint8Array): HistoryRecipientKeyPair {
  requireLength(seed, HISTORY_SECRET_KEY_LENGTH, '历史记录私钥长度无效');
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  return { secretKey: Uint8Array.from(seed), publicKey };
}

/** `SHA-256(pk)[0..16]`, how wrapped keys name their recipient. */
export function historyRecipientId(publicKey: Uint8Array): Uint8Array {
  requireLength(publicKey, HISTORY_PUBLIC_KEY_LENGTH, '历史记录公钥长度无效');
  return sha256(publicKey).slice(0, HISTORY_RECIPIENT_ID_LENGTH);
}

export function newHistorySegmentKey(): HistorySegmentKey {
  return { kid: randomBytes(HISTORY_KID_LENGTH), dek: randomBytes(HISTORY_DEK_LENGTH) };
}

/** Wraps the segment DEK for one recipient under a fresh X-Wing encapsulation. */
export function wrapHistoryKey(key: HistorySegmentKey, recipientPublicKey: Uint8Array): HistoryWrappedKey {
  requireSegmentKey(key);
  const rid = historyRecipientId(recipientPublicKey);
  let encapsulation: { cipherText: Uint8Array; sharedSecret: Uint8Array };
  try {
    encapsulation = ml_kem768_x25519.encapsulate(recipientPublicKey);
  } catch {
    throw new Error('历史记录公钥无效');
  }
  const { cipherText, sharedSecret } = encapsulation;
  const info = wrapInfo(key.kid, rid);
  const kek = hkdf(sha256, sharedSecret, cipherText, info, 32);
  try {
    // A zero nonce is safe: every encapsulation yields a fresh KEK.
    const wrapped = chacha20poly1305(kek, new Uint8Array(12), info).encrypt(key.dek);
    return { rid, kemCt: cipherText, wrapped };
  } finally {
    kek.fill(0);
    sharedSecret.fill(0);
  }
}

/** Device-side unwrap with the recipient's 32-byte X-Wing seed. */
export function unwrapHistoryKey(
  secretKey: Uint8Array,
  wrapped: HistoryWrappedKey,
  kid: Uint8Array,
): HistorySegmentKey {
  requireLength(kid, HISTORY_KID_LENGTH, '历史记录密钥编号长度无效');
  requireWrappedKey(wrapped);
  const { publicKey } = historyRecipientKeyPairFromSeed(secretKey);
  const rid = historyRecipientId(publicKey);
  if (!equalBytes(rid, wrapped.rid)) {
    throw new Error('历史记录密钥不属于当前设备');
  }
  const sharedSecret = ml_kem768_x25519.decapsulate(wrapped.kemCt, secretKey);
  const info = wrapInfo(kid, rid);
  const kek = hkdf(sha256, sharedSecret, wrapped.kemCt, info, 32);
  try {
    const dek = chacha20poly1305(kek, new Uint8Array(12), info).decrypt(wrapped.wrapped);
    return { kid: Uint8Array.from(kid), dek };
  } catch {
    throw new Error('历史记录密钥认证失败');
  } finally {
    kek.fill(0);
    sharedSecret.fill(0);
  }
}

/** Seals one record. `counter` is the event sequence or frame index. */
export function sealHistoryContent(
  key: HistorySegmentKey,
  conversationId: string,
  stream: HistoryContentStream,
  counter: number | bigint,
  plaintext: Uint8Array,
): Uint8Array {
  requireSegmentKey(key);
  const { nonce, aad } = contentParams(key.kid, conversationId, stream, counter);
  return chacha20poly1305(key.dek, nonce, aad).encrypt(plaintext);
}

export function openHistoryContent(
  key: HistorySegmentKey,
  conversationId: string,
  stream: HistoryContentStream,
  counter: number | bigint,
  ciphertext: Uint8Array,
): Uint8Array {
  requireSegmentKey(key);
  const { nonce, aad } = contentParams(key.kid, conversationId, stream, counter);
  try {
    return chacha20poly1305(key.dek, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new Error('历史记录密文认证失败');
  }
}

export function encodeHistoryWrappedKey(wrapped: HistoryWrappedKey): HistoryWrappedKeyJson {
  requireWrappedKey(wrapped);
  return {
    rid: encodeBase64Url(wrapped.rid),
    kemCt: encodeBase64Url(wrapped.kemCt),
    wrapped: encodeBase64Url(wrapped.wrapped),
  };
}

export function decodeHistoryWrappedKey(value: HistoryWrappedKeyJson): HistoryWrappedKey {
  if (
    typeof value?.rid !== 'string' ||
    typeof value.kemCt !== 'string' ||
    typeof value.wrapped !== 'string'
  ) {
    throw new Error('历史记录包装密钥格式无效');
  }
  const wrapped = {
    rid: decodeBase64UrlBytes(value.rid),
    kemCt: decodeBase64UrlBytes(value.kemCt),
    wrapped: decodeBase64UrlBytes(value.wrapped),
  };
  requireWrappedKey(wrapped);
  return wrapped;
}

/** `LABEL || "/wrap" || kid || rid`: the HKDF info and the AEAD AAD. */
function wrapInfo(kid: Uint8Array, rid: Uint8Array): Uint8Array {
  return concatBytes(LABEL, utf8ToBytes('/wrap'), kid, rid);
}

function contentParams(
  kid: Uint8Array,
  conversationId: string,
  stream: HistoryContentStream,
  counter: number | bigint,
): { nonce: Uint8Array; aad: Uint8Array } {
  if (!Object.values(HistoryContentStream).includes(stream)) {
    throw new Error('历史记录内容流编号无效');
  }
  if (typeof counter === 'number' && !Number.isSafeInteger(counter)) {
    throw new Error('历史记录计数无效');
  }
  const value = BigInt(counter);
  if (value < 0n || value > MAX_U64) {
    throw new Error('历史记录计数无效');
  }
  const position = new Uint8Array(12);
  const view = new DataView(position.buffer);
  view.setUint32(0, stream, false);
  view.setBigUint64(4, value, false);
  const aad = concatBytes(
    LABEL,
    utf8ToBytes('/content\0'),
    utf8ToBytes(conversationId),
    new Uint8Array([0]),
    kid,
    position,
  );
  return { nonce: position, aad };
}

function requireSegmentKey(key: HistorySegmentKey): void {
  requireLength(key.kid, HISTORY_KID_LENGTH, '历史记录密钥编号长度无效');
  requireLength(key.dek, HISTORY_DEK_LENGTH, '历史记录密钥长度无效');
}

function requireWrappedKey(wrapped: HistoryWrappedKey): void {
  requireLength(wrapped.rid, HISTORY_RECIPIENT_ID_LENGTH, '历史记录包装密钥格式无效');
  requireLength(wrapped.kemCt, HISTORY_KEM_CIPHERTEXT_LENGTH, '历史记录包装密钥格式无效');
  requireLength(wrapped.wrapped, HISTORY_WRAPPED_DEK_LENGTH, '历史记录包装密钥格式无效');
}

function requireLength(bytes: Uint8Array, length: number, message: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(message);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}
