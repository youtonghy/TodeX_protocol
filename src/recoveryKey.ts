import { sha256 } from '@noble/hashes/sha2.js';

import { BIP39_ENGLISH_WORDLIST } from './bip39English';
import { HISTORY_SECRET_KEY_LENGTH } from './historyCrypto';
import { decodeBase64UrlBytes, encodeBase64Url } from './transportCrypto';

// The history recovery key is a 32-byte X-Wing seed (docs/history-encryption.md
// §3.3), shown once as 24 BIP39 English words and as a QR code. Only its
// public key ever reaches the backend (`history.recovery.set`).

export const RECOVERY_WORD_COUNT = 24;
export const RECOVERY_QR_PREFIX = 'todex-recovery:v1:';

const WORD_INDEX = new Map(BIP39_ENGLISH_WORDLIST.map((word, index) => [word, index]));
/** BIP39 English words are unique by their first four letters. */
const PREFIX_INDEX = new Map(BIP39_ENGLISH_WORDLIST.map((word, index) => [word.slice(0, 4), index]));

/** 32 bytes of entropy → 24 words: 256 bits plus the 8-bit SHA-256 checksum. */
export function recoveryWordsFromSeed(seed: Uint8Array): string[] {
  requireSeed(seed);
  const bits = new Uint8Array(HISTORY_SECRET_KEY_LENGTH + 1);
  bits.set(seed);
  bits[HISTORY_SECRET_KEY_LENGTH] = sha256(seed)[0];
  const words: string[] = [];
  for (let index = 0; index < RECOVERY_WORD_COUNT; index++) {
    words.push(BIP39_ENGLISH_WORDLIST[readBits(bits, index * 11, 11)]);
  }
  bits.fill(0);
  return words;
}

/** Parses 24 words (any case and whitespace; a word's first four letters are
 * enough) and verifies the BIP39 checksum. */
export function recoverySeedFromWords(input: string | readonly string[]): Uint8Array {
  const words = (typeof input === 'string' ? input.split(/\s+/) : [...input])
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length !== RECOVERY_WORD_COUNT) {
    throw new Error(`恢复密钥需要 ${RECOVERY_WORD_COUNT} 个单词，当前为 ${words.length} 个`);
  }
  const bits = new Uint8Array(HISTORY_SECRET_KEY_LENGTH + 1);
  words.forEach((word, position) => {
    const index = WORD_INDEX.get(word) ?? (word.length >= 4 ? PREFIX_INDEX.get(word.slice(0, 4)) : undefined);
    if (index === undefined) throw new Error(`第 ${position + 1} 个单词「${word}」不在 BIP39 英文词表中`);
    writeBits(bits, position * 11, 11, index);
  });
  const seed = bits.slice(0, HISTORY_SECRET_KEY_LENGTH);
  const checksum = bits[HISTORY_SECRET_KEY_LENGTH];
  bits.fill(0);
  if (sha256(seed)[0] !== checksum) {
    seed.fill(0);
    throw new Error('恢复密钥校验失败，请检查单词顺序与拼写');
  }
  return seed;
}

export function recoveryQrPayload(seed: Uint8Array): string {
  requireSeed(seed);
  return `${RECOVERY_QR_PREFIX}${encodeBase64Url(seed)}`;
}

export function recoverySeedFromQrPayload(payload: string): Uint8Array {
  const text = payload.trim();
  if (!text.startsWith(RECOVERY_QR_PREFIX)) throw new Error('不是 TodeX 恢复密钥二维码');
  const encoded = text.slice(RECOVERY_QR_PREFIX.length);
  let seed: Uint8Array;
  try {
    seed = decodeBase64UrlBytes(encoded);
  } catch {
    throw new Error('恢复密钥二维码内容无效');
  }
  if (seed.length !== HISTORY_SECRET_KEY_LENGTH || encodeBase64Url(seed) !== encoded) {
    seed.fill(0);
    throw new Error('恢复密钥二维码内容无效');
  }
  return seed;
}

/** Accepts either form a user may paste: the QR text or the 24 words. */
export function parseRecoveryKey(input: string): Uint8Array {
  return input.trim().startsWith(RECOVERY_QR_PREFIX) ? recoverySeedFromQrPayload(input) : recoverySeedFromWords(input);
}

function requireSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== HISTORY_SECRET_KEY_LENGTH) {
    throw new Error('恢复密钥长度无效');
  }
}

function readBits(bytes: Uint8Array, offset: number, count: number): number {
  let value = 0;
  for (let bit = 0; bit < count; bit++) {
    const position = offset + bit;
    value = (value << 1) | ((bytes[position >> 3] >> (7 - (position & 7))) & 1);
  }
  return value;
}

function writeBits(bytes: Uint8Array, offset: number, count: number, value: number): void {
  for (let bit = 0; bit < count; bit++) {
    const position = offset + bit;
    if ((value >> (count - 1 - bit)) & 1) bytes[position >> 3] |= 1 << (7 - (position & 7));
  }
}
