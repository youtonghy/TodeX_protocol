// Pairing-link parsing and the base64url helpers shared by the crypto
// modules. The transport itself (WebSocket frames and the REST tunnel) is
// transport v2 in `secureChannel.ts` / `secureTransport.ts`; `todex.crypto.v1`
// is gone. A pairing link carries only the server address: the transport
// protocol and key are pinned exclusively by a verified device pairing
// (`parseDevicePairingTransport` / `verifyDevicePairingCredential`).

export type TransportEncryptionProtocol = 'none' | 'x25519' | 'ml-kem-768';

/**
 * Reads the server address out of a scanned or pasted pairing link:
 * `{"kind":"todex-pairing-link","version":1|2,"serverUrl":"..."}` (every
 * other field, including any legacy protocol, key or token, is ignored) or a
 * bare `http(s)://` / `ws(s)://` URL. Importing a link only fills the address;
 * the caller then starts device pairing.
 */
export function parsePairingAddress(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text.startsWith('{')) {
    if (/^(https?|wss?):\/\/[^\s]+$/i.test(text)) {
      try {
        new URL(text);
        return text;
      } catch {
        // Falls through to the shared error below.
      }
    }
    throw new Error('不是有效的 TodeX 配对链接');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 TodeX 配对链接');
  }
  const link = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as { kind?: unknown; version?: unknown; serverUrl?: unknown }
    : null;
  if (!link || link.kind !== 'todex-pairing-link' || (link.version !== 1 && link.version !== 2)) {
    throw new Error('不是有效的 TodeX 配对链接');
  }
  if (typeof link.serverUrl !== 'string' || !link.serverUrl.trim()) {
    throw new Error('配对链接缺少后端地址');
  }
  return link.serverUrl.trim();
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
