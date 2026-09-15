import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import type { ConnectionSettings } from './todex';

export type TransportEncryptionProtocol = 'none' | 'x25519' | 'ml-kem-768';

type PairingProtocol = {
  id: string;
  publicKey: string;
};

type PairingLinkPayload = {
  kind: 'todex-pairing-link';
  version: number;
  serverUrl: string;
  authToken?: string;
  preferredEncryption?: TransportEncryptionProtocol;
  protocol?: PairingProtocol;
};

type PairingChunkPayload = {
  kind: 'todex-pairing-chunk';
  version: number;
  checksum: string;
  index: number;
  total: number;
  data: string;
};

type PairingQrEnvelope = {
  kind?: unknown;
  version?: unknown;
  serverUrl?: unknown;
  authToken?: unknown;
  preferredEncryption?: unknown;
  protocol?: unknown;
  checksum?: unknown;
  index?: unknown;
  total?: unknown;
  data?: unknown;
};

export type ParsedPairing = {
  serverUrl: string;
  authToken: string;
  encryptionProtocol: TransportEncryptionProtocol;
  encryptionPublicKey: string;
  importWarning?: string;
};

export type PairingQrChunk = {
  checksum: string;
  index: number;
  total: number;
  data: string;
};

export type PairingQrFrame =
  | {
      kind: 'pairing';
      raw: string;
    }
  | {
      kind: 'chunk';
      chunk: PairingQrChunk;
    };

export type TransportCryptoSession = {
  protocol: Exclude<TransportEncryptionProtocol, 'none'>;
  queryString: string;
  encryptClientText: (plaintext: string) => string;
  decryptServerText: (frame: string) => string;
};

const AAD = utf8('todex-ws-transport-crypto-v1');

export async function resolvePairingPayload(raw: string): Promise<ParsedPairing> {
  const parsed = JSON.parse(raw) as Partial<PairingLinkPayload>;
  return parsePairingLinkObject(parsed);
}

export function parsePairingQrFrame(raw: string): PairingQrFrame {
  const parsed = JSON.parse(raw) as PairingQrEnvelope;
  if (parsed.kind === 'todex-pairing-link' && parsed.version === 1) {
    return { kind: 'pairing', raw };
  }
  if (parsed.kind === 'todex-pairing-chunk' && parsed.version === 1) {
    return {
      kind: 'chunk',
      chunk: parsePairingQrChunk(parsed),
    };
  }
  throw new Error('不是有效的 TodeX 配对二维码');
}

export function assemblePairingQrChunkPayload(chunks: PairingQrChunk[]): string {
  if (chunks.length === 0) {
    throw new Error('分段二维码内容为空');
  }
  const [firstChunk] = chunks;
  const sortedChunks = [...chunks].sort((left, right) => left.index - right.index);
  const seen = new Set<number>();
  for (const chunk of sortedChunks) {
    if (chunk.checksum !== firstChunk.checksum) {
      throw new Error('分段二维码批次不一致');
    }
    if (chunk.total !== firstChunk.total) {
      throw new Error('分段二维码总数不一致');
    }
    if (!Number.isInteger(chunk.index) || chunk.index < 1 || chunk.index > chunk.total) {
      throw new Error('分段二维码序号无效');
    }
    if (seen.has(chunk.index)) {
      throw new Error('分段二维码存在重复分片');
    }
    seen.add(chunk.index);
  }
  if (sortedChunks.length !== firstChunk.total) {
    throw new Error('分段二维码内容不完整');
  }
  const assembled = sortedChunks.map((chunk) => chunk.data).join('');
  const decoded = decodeBase64UrlBytes(assembled);
  const digest = encodeBase64Url(sha256(decoded));
  if (digest !== firstChunk.checksum) {
    throw new Error('分段二维码校验失败');
  }
  return new TextDecoder().decode(decoded);
}

function parsePairingLinkObject(parsed: Partial<PairingLinkPayload>): ParsedPairing {
  if (parsed.kind !== 'todex-pairing-link' || parsed.version !== 1) {
    throw new Error('不是有效的 TodeX 配对链接二维码');
  }
  if (!parsed.serverUrl) {
    throw new Error('配对二维码缺少后端地址');
  }
  const protocol = parsed.protocol;
  const protocolId = normalizePairingProtocol(protocol?.id);
  const selectedProtocol = normalizePairingProtocol(parsed.preferredEncryption) ?? protocolId ?? 'none';
  if (selectedProtocol === 'none') {
    return {
      serverUrl: parsed.serverUrl,
      authToken: parsed.authToken ?? '',
      encryptionProtocol: 'none',
      encryptionPublicKey: '',
    };
  }
  if (protocol?.publicKey) {
    if (protocolId !== selectedProtocol) {
      throw new Error('配对二维码的加密方式和公钥不匹配');
    }
    return {
      serverUrl: parsed.serverUrl,
      authToken: parsed.authToken ?? '',
      encryptionProtocol: selectedProtocol,
      encryptionPublicKey: protocol.publicKey,
    };
  }
  throw new Error('配对二维码缺少当前加密方式的公钥');
}

function parsePairingQrChunk(parsed: PairingQrEnvelope): PairingQrChunk {
  if (typeof parsed.checksum !== 'string' || !parsed.checksum) {
    throw new Error('分段二维码缺少校验值');
  }
  if (typeof parsed.data !== 'string' || !parsed.data) {
    throw new Error('分段二维码缺少内容');
  }
  const index = parsed.index;
  if (!Number.isInteger(index) || (index as number) < 1) {
    throw new Error('分段二维码序号无效');
  }
  const total = parsed.total;
  if (!Number.isInteger(total) || (total as number) < 1) {
    throw new Error('分段二维码总数无效');
  }
  const chunkIndex = index as number;
  const chunkTotal = total as number;
  return {
    checksum: parsed.checksum,
    index: chunkIndex,
    total: chunkTotal,
    data: parsed.data,
  };
}

function normalizePairingProtocol(protocol: unknown): TransportEncryptionProtocol | null {
  return protocol === 'none' || protocol === 'x25519' || protocol === 'ml-kem-768' ? protocol : null;
}

export function applyPairingToSettings(
  settings: ConnectionSettings,
  pairing: ParsedPairing,
): ConnectionSettings {
  return {
    ...settings,
    serverUrl: pairing.serverUrl,
    authToken: pairing.authToken,
    encryptionProtocol: pairing.encryptionProtocol,
    encryptionPublicKey: pairing.encryptionPublicKey,
  };
}

export function createTransportCryptoSession(settings: ConnectionSettings): TransportCryptoSession | null {
  if (settings.encryptionProtocol === 'none') {
    return null;
  }
  const protocol = settings.encryptionProtocol;
  const serverPublicKey = decodeBase64Url(settings.encryptionPublicKey.trim());
  if (serverPublicKey.length === 0) {
    throw new Error('当前连接未配置加密公钥，请扫描后端配对二维码。');
  }

  const handshake =
    protocol === 'x25519'
      ? createX25519Handshake(serverPublicKey)
      : createMlKem768Handshake(serverPublicKey);
  const key = hkdf(sha256, handshake.sharedSecret, handshake.salt, utf8(protocol), 32);
  let sendCounter = 0;

  return {
    protocol,
    queryString: handshake.queryString,
    encryptClientText: (plaintext: string) => {
      const nonce = nonceFor(2, sendCounter++);
      const ciphertext = xchacha20poly1305(key, nonce, AAD).encrypt(utf8(plaintext));
      return JSON.stringify({
        type: 'todex.crypto.v1',
        protocol,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
      });
    },
    decryptServerText: (frame: string) => {
      const wrapped = JSON.parse(frame) as {
        type?: string;
        protocol?: string;
        nonce?: string;
        ciphertext?: string;
      };
      if (wrapped.type !== 'todex.crypto.v1' || wrapped.protocol !== protocol) {
        throw new Error('收到的加密帧格式不正确');
      }
      if (!wrapped.nonce || !wrapped.ciphertext) {
        throw new Error('收到的加密帧缺少 nonce 或 ciphertext');
      }
      const nonce = decodeBase64UrlBytes(wrapped.nonce);
      if (nonce.length !== 24 || nonce[0] !== 1) {
        throw new Error('收到的加密帧方向不正确');
      }
      const plaintext = xchacha20poly1305(key, nonce, AAD).decrypt(
        decodeBase64UrlBytes(wrapped.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    },
  };
}

function createX25519Handshake(serverPublicKey: Uint8Array): {
  queryString: string;
  sharedSecret: Uint8Array;
  salt: Uint8Array;
} {
  if (serverPublicKey.length !== 32) {
    throw new Error('X25519 服务端公钥长度不正确');
  }
  const keyPair = x25519.keygen();
  const sharedSecret = x25519.getSharedSecret(keyPair.secretKey, serverPublicKey);
  const salt = concatBytes(serverPublicKey, keyPair.publicKey);
  const queryString = new URLSearchParams({
    enc: 'x25519',
    client_key: encodeBase64Url(keyPair.publicKey),
  }).toString();
  return { queryString, sharedSecret, salt };
}

function createMlKem768Handshake(serverPublicKey: Uint8Array): {
  queryString: string;
  sharedSecret: Uint8Array;
  salt: Uint8Array;
} {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(serverPublicKey);
  const salt = concatBytes(serverPublicKey, cipherText);
  const queryString = new URLSearchParams({
    enc: 'ml-kem-768',
    ciphertext: encodeBase64Url(cipherText),
  }).toString();
  return { queryString, sharedSecret, salt };
}

function nonceFor(direction: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce[0] = direction;
  const view = new DataView(nonce.buffer);
  view.setBigUint64(8, BigInt(counter), true);
  return nonce;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let idx = 0; idx < bytes.length; idx += 3) {
    const first = bytes[idx];
    const second = bytes[idx + 1];
    const third = bytes[idx + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(chunk >> 18) & 63];
    output += alphabet[(chunk >> 12) & 63];
    if (idx + 1 < bytes.length) {
      output += alphabet[(chunk >> 6) & 63];
    }
    if (idx + 2 < bytes.length) {
      output += alphabet[chunk & 63];
    }
  }
  return output;
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const globalAtob = (globalThis as unknown as { atob?: (input: string) => string }).atob;
  if (typeof globalAtob === 'function') {
    return binaryToBytes(globalAtob(padded));
  }
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer;
  if (nodeBuffer) {
    return binaryToBytes(nodeBuffer.from(padded, 'base64').toString('binary'));
  }
  return decodeBase64Url(value);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  for (let idx = 0; idx < padded.length; idx += 4) {
    const chunk = padded.slice(idx, idx + 4);
    const values = [...chunk].map((char) => (char === '=' ? 0 : alphabet.indexOf(char)));
    if (values.some((entry) => entry < 0)) {
      throw new Error('无效的 base64url 数据');
    }
    const triplet = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    bytes.push((triplet >> 16) & 255);
    if (chunk[2] !== '=') {
      bytes.push((triplet >> 8) & 255);
    }
    if (chunk[3] !== '=') {
      bytes.push(triplet & 255);
    }
  }
  return new Uint8Array(bytes);
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
