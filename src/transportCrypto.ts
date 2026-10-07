import { sha256 } from '@noble/hashes/sha2.js';

import type { ConnectionSettings } from './todex';

// Pairing QR parsing and the pinned transport key. The transport itself
// (WebSocket frames and the REST tunnel) is transport v2 in
// `secureChannel.ts` / `secureTransport.ts`; `todex.crypto.v1` is gone.

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

export function encodeBase64Url(bytes: Uint8Array): string {
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

export function decodeBase64UrlBytes(value: string): Uint8Array {
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
