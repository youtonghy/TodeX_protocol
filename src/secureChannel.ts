import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { MAX_LEGACY_MESSAGE_BYTES } from './transport';
import { decodeBase64UrlBytes, encodeBase64Url } from './transportCrypto';

// Transport v2 reference implementation (spec: transport-v2.md, "TodeX
// transport v2"). Byte-for-byte shared with the backend (Rust) and TodexCore
// (Swift) through tests/fixtures/transport-v2.json; regenerate that file with
// scripts/generate-transport-v2-vectors.cjs.
//
// Everything below is pure: callers own sockets and HTTP. `secureTransport.ts`
// wires these primitives to `fetch` and `WebSocket`.

export type SecureTransportProtocol = 'x25519' | 'ml-kem-768';

export const TRANSPORT_V2_VERSION = 2;
export const TRANSPORT_V2_WS_LABEL = 'todex.transport.v2/ws';
export const TRANSPORT_V2_REST_LABEL = 'todex.transport.v2/rest';
export const TRANSPORT_V2_DIRECTION_UP = 0x02;
export const TRANSPORT_V2_DIRECTION_DOWN = 0x01;
export const TRANSPORT_V2_NONCE_LENGTH = 32;
export const TRANSPORT_V2_KEY_LENGTH = 32;
export const TRANSPORT_V2_TAG_LENGTH = 16;
/** Maximum plaintext of one REST record. */
export const TRANSPORT_V2_RECORD_PLAINTEXT_MAX = 65536;
/** WebSocket binary frames carry `u64_be(i)` before the ciphertext. */
export const TRANSPORT_V2_WS_FRAME_OVERHEAD = 8 + TRANSPORT_V2_TAG_LENGTH;
/**
 * Upper bound for the JSON head of an inner REST request/response. The spec
 * does not fix one; heads only carry a handful of headers, and bounding them
 * keeps a hostile peer from making the client buffer an unbounded head.
 */
export const TRANSPORT_V2_MAX_HEAD_BYTES = 65536;
export const TRANSPORT_V2_SEALED_CONTENT_TYPE = 'application/vnd.todex.sealed';
export const TRANSPORT_V2_SEALED_PATH = '/v2/sealed';
export const TRANSPORT_V2_WS_CLOSE_CODE = 4400;
export const TRANSPORT_V2_WS_CLOSE_REASON = 'transport crypto failure';

export const TRANSPORT_V2_HEADERS = {
  transport: 'x-todex-transport',
  encryption: 'x-todex-encryption',
  clientKey: 'x-todex-client-key',
  kemCiphertext: 'x-todex-kem-ciphertext',
  requestNonce: 'x-todex-request-nonce',
} as const;

const X25519_PUBLIC_KEY_LENGTH = 32;
const ML_KEM_768_PUBLIC_KEY_LENGTH = 1184;
const ML_KEM_768_CIPHERTEXT_LENGTH = 1088;
const RECORD_CIPHERTEXT_MAX = TRANSPORT_V2_RECORD_PLAINTEXT_MAX + TRANSPORT_V2_TAG_LENGTH;
const MAX_U64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();
// `fatal` so invalid UTF-8 from a peer is a crypto/protocol failure rather
// than silently replaced characters.
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Any failure to open, decode or authenticate v2 data. Deliberately carries
 * no detail beyond a short internal reason: WebSocket callers close with
 * `4400 transport crypto failure`, REST callers fail the request.
 */
export class TransportCryptoError extends Error {
  readonly code = 'TRANSPORT_CRYPTO_FAILED';
  readonly closeCode = TRANSPORT_V2_WS_CLOSE_CODE;
  readonly closeReason = TRANSPORT_V2_WS_CLOSE_REASON;

  constructor(readonly reason: string) {
    super(`transport crypto failure: ${reason}`);
    this.name = 'TransportCryptoError';
  }
}

/** A plaintext rejected by the size pre-check; no counter was consumed. */
export class TransportPayloadTooLargeError extends Error {
  readonly code = 'MESSAGE_TOO_LARGE';

  constructor(readonly size: number, readonly limit: number) {
    super(`plaintext of ${size} bytes exceeds the ${limit} byte limit`);
    this.name = 'TransportPayloadTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readU64be(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
}

/** `LP(x) = u32_be(len(x)) || x`. */
export function lengthPrefixed(value: Uint8Array): Uint8Array {
  return concat(u32be(value.length), value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function wipe(...values: Array<Uint8Array | null | undefined>): void {
  for (const value of values) value?.fill(0);
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

function decodeKey(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? decodeBase64UrlBytes(value.trim()) : Uint8Array.from(value);
}

export function parseSecureTransportProtocol(value: unknown): SecureTransportProtocol | null {
  return value === 'x25519' || value === 'ml-kem-768' ? value : null;
}

// ---------------------------------------------------------------------------
// Key agreement and key schedule
// ---------------------------------------------------------------------------

/** Deterministic overrides for vectors and tests; production leaves these unset. */
export type ClientHandshakeRandomness = {
  /** x25519 only: the client's ephemeral secret key (32 bytes). */
  x25519SecretKey?: Uint8Array;
  /** ml-kem-768 only: the 32-byte encapsulation message (FIPS 203 `m`). */
  mlKemMessage?: Uint8Array;
};

export type ClientHandshake = {
  protocol: SecureTransportProtocol;
  /** `client_public` (x25519, 32 B) or the KEM ciphertext (ml-kem-768, 1088 B). */
  clientMaterial: Uint8Array;
  shared: Uint8Array;
};

/** Runs the client side of the key agreement against the pinned server key. */
export function clientHandshake(
  protocol: SecureTransportProtocol,
  serverStaticPublic: Uint8Array,
  randomness: ClientHandshakeRandomness = {},
): ClientHandshake {
  if (protocol === 'x25519') {
    if (serverStaticPublic.length !== X25519_PUBLIC_KEY_LENGTH) {
      throw new TransportCryptoError('x25519 server key length');
    }
    const secretKey = randomness.x25519SecretKey
      ? Uint8Array.from(randomness.x25519SecretKey)
      : x25519.utils.randomSecretKey();
    try {
      const clientPublic = x25519.getPublicKey(secretKey);
      let shared: Uint8Array;
      try {
        shared = x25519.getSharedSecret(secretKey, serverStaticPublic);
      } catch {
        throw new TransportCryptoError('x25519 shared secret');
      }
      if (isAllZero(shared)) {
        throw new TransportCryptoError('x25519 shared secret is zero');
      }
      return { protocol, clientMaterial: clientPublic, shared };
    } finally {
      wipe(secretKey);
    }
  }
  if (serverStaticPublic.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new TransportCryptoError('ml-kem-768 server key length');
  }
  let encapsulated: { cipherText: Uint8Array; sharedSecret: Uint8Array };
  try {
    encapsulated = ml_kem768.encapsulate(serverStaticPublic, randomness.mlKemMessage);
  } catch {
    throw new TransportCryptoError('ml-kem-768 encapsulation');
  }
  return { protocol, clientMaterial: encapsulated.cipherText, shared: encapsulated.sharedSecret };
}

export type TransportKeyScheduleInput = {
  label: string;
  protocol: SecureTransportProtocol;
  deviceId: string;
  serverStaticPublic: Uint8Array;
  clientMaterial: Uint8Array;
  clientNonce: Uint8Array;
  /** 32 bytes for WebSocket, empty for REST. */
  serverNonce: Uint8Array;
  shared: Uint8Array;
};

export type TransportKeys = {
  th: Uint8Array;
  kUp: Uint8Array;
  kDown: Uint8Array;
};

/** `th = SHA256(LP(label) || ... || LP(server_nonce))`. */
export function transportTranscriptHash(input: Omit<TransportKeyScheduleInput, 'shared'>): Uint8Array {
  const transcript = concat(
    lengthPrefixed(encoder.encode(input.label)),
    lengthPrefixed(encoder.encode(input.protocol)),
    lengthPrefixed(encoder.encode(input.deviceId)),
    lengthPrefixed(input.serverStaticPublic),
    lengthPrefixed(input.clientMaterial),
    lengthPrefixed(input.clientNonce),
    lengthPrefixed(input.serverNonce),
  );
  try {
    return sha256(transcript);
  } finally {
    wipe(transcript);
  }
}

/** HKDF-SHA256 with `salt = th`, `ikm = shared`, info `label/up` and `label/down`. */
export function deriveTransportKeys(input: TransportKeyScheduleInput): TransportKeys {
  const th = transportTranscriptHash(input);
  const prk = extract(sha256, input.shared, th);
  try {
    return {
      th,
      kUp: expand(sha256, prk, encoder.encode(`${input.label}/up`), TRANSPORT_V2_KEY_LENGTH),
      kDown: expand(sha256, prk, encoder.encode(`${input.label}/down`), TRANSPORT_V2_KEY_LENGTH),
    };
  } finally {
    wipe(prk);
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** `nonce_i = 16 zero bytes || u64_be(i)`. */
export function recordNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce.set(u64be(counter), 16);
  return nonce;
}

/** `aad_i = th || direction || final`. */
export function recordAad(th: Uint8Array, direction: number, final: boolean): Uint8Array {
  return concat(th, Uint8Array.of(direction, final ? 1 : 0));
}

function checkCounter(counter: bigint): void {
  // A counter is spent once used; `u64::MAX` is never used so that the
  // "next expected" value always fits in a u64 (mirrors `checked_add`).
  if (counter < 0n || counter >= MAX_U64) {
    throw new TransportCryptoError('record counter exhausted');
  }
}

export function sealRecord(
  key: Uint8Array,
  th: Uint8Array,
  direction: number,
  counter: bigint,
  final: boolean,
  plaintext: Uint8Array,
): Uint8Array {
  checkCounter(counter);
  return xchacha20poly1305(key, recordNonce(counter), recordAad(th, direction, final)).encrypt(plaintext);
}

export function openRecord(
  key: Uint8Array,
  th: Uint8Array,
  direction: number,
  counter: bigint,
  final: boolean,
  ciphertext: Uint8Array,
): Uint8Array {
  checkCounter(counter);
  if (ciphertext.length < TRANSPORT_V2_TAG_LENGTH) {
    throw new TransportCryptoError('record too short');
  }
  try {
    return xchacha20poly1305(key, recordNonce(counter), recordAad(th, direction, final)).decrypt(ciphertext);
  } catch {
    throw new TransportCryptoError('record authentication');
  }
}

/**
 * One direction of a keyed record stream with a strictly increasing counter.
 * The counter advances only after a record is sealed/opened successfully.
 */
export class RecordCipher {
  private counter = 0n;
  private key: Uint8Array;
  private readonly th: Uint8Array;
  private disposed = false;

  constructor(key: Uint8Array, th: Uint8Array, private readonly direction: number) {
    this.key = Uint8Array.from(key);
    this.th = Uint8Array.from(th);
  }

  /** The counter of the next record. */
  get nextCounter(): bigint {
    return this.counter;
  }

  seal(plaintext: Uint8Array, final: boolean): { counter: bigint; ciphertext: Uint8Array } {
    this.assertLive();
    const counter = this.counter;
    const ciphertext = sealRecord(this.key, this.th, this.direction, counter, final, plaintext);
    this.counter = counter + 1n;
    return { counter, ciphertext };
  }

  /** Opens record `counter`; anything but the next expected counter is fatal. */
  open(counter: bigint, ciphertext: Uint8Array, final: boolean): Uint8Array {
    this.assertLive();
    if (counter !== this.counter) {
      throw new TransportCryptoError('unexpected record counter');
    }
    const plaintext = openRecord(this.key, this.th, this.direction, counter, final, ciphertext);
    this.counter = counter + 1n;
    return plaintext;
  }

  dispose(): void {
    this.disposed = true;
    wipe(this.key, this.th);
  }

  private assertLive(): void {
    if (this.disposed) throw new TransportCryptoError('cipher disposed');
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Encrypted WS frame length for a plaintext of `plaintextBytes` UTF-8 bytes. */
export function sealedWsFrameLength(plaintextBytes: number): number {
  return plaintextBytes + TRANSPORT_V2_WS_FRAME_OVERHEAD;
}

/**
 * Size pre-check before sealing ("Client rules", last item). The backend
 * limits the received frame (`MAX_LEGACY_MESSAGE_BYTES`), so the plaintext
 * limit is that minus the frame overhead. Throws without touching counters.
 */
export function assertWsPlaintextFits(
  plaintext: string | Uint8Array,
  maxFrameBytes = MAX_LEGACY_MESSAGE_BYTES,
): Uint8Array {
  const bytes = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
  const limit = maxFrameBytes - TRANSPORT_V2_WS_FRAME_OVERHEAD;
  if (bytes.length > limit) {
    throw new TransportPayloadTooLargeError(bytes.length, limit);
  }
  return bytes;
}

/** Generic plaintext pre-check for REST bodies (per-route limits). */
export function assertPlaintextFits(byteLength: number, limit: number): void {
  if (byteLength > limit) {
    throw new TransportPayloadTooLargeError(byteLength, limit);
  }
}

export type WsChannelOptions = {
  protocol: SecureTransportProtocol;
  /** Pinned server static public key, raw bytes or base64url. */
  serverPublicKey: Uint8Array | string;
  /** Device id from the signed upgrade credential; empty when auth is disabled. */
  deviceId: string;
  /** Frame-size limit for the pre-check (defaults to `MAX_LEGACY_MESSAGE_BYTES`). */
  maxFrameBytes?: number;
  /** Test/vector overrides. */
  randomness?: ClientHandshakeRandomness & { clientNonce?: Uint8Array };
};

export type WsHello = { type: 'todex.transport.hello'; version: 2; serverNonce: string };

export type WsChannelSession = {
  protocol: SecureTransportProtocol;
  /** `u64_be(i) || AEAD(k_up, ...)` for one JSON text message. */
  seal: (text: string) => Uint8Array;
  /** Opens one binary frame from the server; throws `TransportCryptoError`. */
  open: (frame: Uint8Array) => string;
  dispose: () => void;
};

export type WsChannelHandshake = {
  protocol: SecureTransportProtocol;
  /** `tv`, `enc`, `client_nonce` and `client_key` | `ciphertext`. */
  queryParams: Record<string, string>;
  queryString: string;
  /** Consumes the server hello (the first, text message). Single use. */
  acceptHello: (text: string) => WsChannelSession;
  dispose: () => void;
};

/** Parses `{"type":"todex.transport.hello","version":2,"serverNonce":...}`. */
export function parseWsHello(text: string): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TransportCryptoError('hello is not JSON');
  }
  const hello = value as Partial<WsHello> | null;
  if (
    !hello
    || typeof hello !== 'object'
    || hello.type !== 'todex.transport.hello'
    || hello.version !== TRANSPORT_V2_VERSION
    || typeof hello.serverNonce !== 'string'
  ) {
    throw new TransportCryptoError('malformed hello');
  }
  const serverNonce = decodeStrictBase64Url(hello.serverNonce);
  if (serverNonce.length !== TRANSPORT_V2_NONCE_LENGTH) {
    throw new TransportCryptoError('hello nonce length');
  }
  return serverNonce;
}

export function createWsChannel(options: WsChannelOptions): WsChannelHandshake {
  const { protocol } = options;
  const serverStaticPublic = decodeKey(options.serverPublicKey);
  const clientNonce = options.randomness?.clientNonce
    ? Uint8Array.from(options.randomness.clientNonce)
    : randomBytes(TRANSPORT_V2_NONCE_LENGTH);
  if (clientNonce.length !== TRANSPORT_V2_NONCE_LENGTH) {
    throw new TransportCryptoError('client nonce length');
  }
  let handshake: ClientHandshake | null = clientHandshake(protocol, serverStaticPublic, options.randomness);
  const queryParams: Record<string, string> = {
    tv: String(TRANSPORT_V2_VERSION),
    enc: protocol,
    client_nonce: encodeBase64Url(clientNonce),
    [protocol === 'x25519' ? 'client_key' : 'ciphertext']: encodeBase64Url(handshake.clientMaterial),
  };
  const maxFrameBytes = options.maxFrameBytes ?? MAX_LEGACY_MESSAGE_BYTES;

  const dispose = () => {
    if (handshake) wipe(handshake.shared);
    handshake = null;
  };

  return {
    protocol,
    queryParams,
    queryString: new URLSearchParams(queryParams).toString(),
    dispose,
    acceptHello: (text: string) => {
      if (!handshake) throw new TransportCryptoError('hello already consumed');
      const current = handshake;
      handshake = null;
      let keys: TransportKeys;
      try {
        const serverNonce = parseWsHello(text);
        keys = deriveTransportKeys({
          label: TRANSPORT_V2_WS_LABEL,
          protocol,
          deviceId: options.deviceId,
          serverStaticPublic,
          clientMaterial: current.clientMaterial,
          clientNonce,
          serverNonce,
          shared: current.shared,
        });
      } finally {
        wipe(current.shared);
      }
      const up = new RecordCipher(keys.kUp, keys.th, TRANSPORT_V2_DIRECTION_UP);
      const down = new RecordCipher(keys.kDown, keys.th, TRANSPORT_V2_DIRECTION_DOWN);
      wipe(keys.kUp, keys.kDown, keys.th);
      return {
        protocol,
        seal: (text: string) => {
          const plaintext = assertWsPlaintextFits(text, maxFrameBytes);
          const { counter, ciphertext } = up.seal(plaintext, false);
          return concat(u64be(counter), ciphertext);
        },
        open: (frame: Uint8Array) => {
          if (frame.length < TRANSPORT_V2_WS_FRAME_OVERHEAD) {
            throw new TransportCryptoError('frame too short');
          }
          const plaintext = down.open(readU64be(frame, 0), frame.subarray(8), false);
          try {
            return strictDecoder.decode(plaintext);
          } catch {
            throw new TransportCryptoError('frame is not UTF-8');
          }
        },
        dispose: () => {
          up.dispose();
          down.dispose();
        },
      };
    },
  };
}

function decodeStrictBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TransportCryptoError('invalid base64url');
  }
  return decodeBase64UrlBytes(value);
}

// ---------------------------------------------------------------------------
// REST record streams
// ---------------------------------------------------------------------------

/**
 * Seals `plaintext` as a REST record stream: 64 KiB records, each written as
 * `u32_be(len(ciphertext)) || ciphertext`, exactly the last one `final`. An
 * empty plaintext still yields one (empty, final) record.
 */
export function sealRecordStream(cipher: RecordCipher, plaintext: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + TRANSPORT_V2_RECORD_PLAINTEXT_MAX, plaintext.length);
    const final = end === plaintext.length;
    const { ciphertext } = cipher.seal(plaintext.subarray(offset, end), final);
    parts.push(u32be(ciphertext.length), ciphertext);
    offset = end;
  } while (offset < plaintext.length);
  return concat(...parts);
}

/**
 * Incremental decoder for a sealed REST record stream. `push` returns the
 * plaintext of every record completed by the chunk; `finish` asserts that the
 * final record arrived and nothing followed it.
 */
export class RecordStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private sawFinal = false;

  constructor(private readonly cipher: RecordCipher) {}

  get complete(): boolean {
    return this.sawFinal;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return [];
    if (this.sawFinal) throw new TransportCryptoError('bytes after final record');
    this.buffer = this.buffer.length ? concat(this.buffer, chunk) : Uint8Array.from(chunk);
    const out: Uint8Array[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = readU32be(this.buffer, offset);
      if (length < TRANSPORT_V2_TAG_LENGTH || length > RECORD_CIPHERTEXT_MAX) {
        throw new TransportCryptoError('record length');
      }
      if (this.buffer.length - offset - 4 < length) break;
      const ciphertext = this.buffer.subarray(offset + 4, offset + 4 + length);
      offset += 4 + length;
      // The final flag is authenticated, and a streaming reader cannot know
      // whether more bytes follow, so `openEither` learns it from the tag.
      const plaintext = this.openEither(ciphertext);
      out.push(plaintext.plaintext);
      if (plaintext.final) {
        this.sawFinal = true;
        if (offset !== this.buffer.length) {
          throw new TransportCryptoError('bytes after final record');
        }
      }
    }
    this.buffer = this.buffer.slice(offset);
    return out;
  }

  finish(): void {
    if (!this.sawFinal || this.buffer.length !== 0) {
      throw new TransportCryptoError('truncated record stream');
    }
  }

  dispose(): void {
    this.cipher.dispose();
    wipe(this.buffer);
  }

  private openEither(ciphertext: Uint8Array): { plaintext: Uint8Array; final: boolean } {
    // Each record authenticates exactly one `final` value. Trying `final = 0`
    // then `final = 1` with the same counter is safe: the counter advances
    // only on success and a forged record fails both.
    const counter = this.cipher.nextCounter;
    try {
      return { plaintext: this.cipher.open(counter, ciphertext, false), final: false };
    } catch {
      // Fall through: the record may be the final one.
    }
    return { plaintext: this.cipher.open(counter, ciphertext, true), final: true };
  }
}

/** One-shot open of a complete record stream. */
export function openRecordStream(cipher: RecordCipher, stream: Uint8Array): Uint8Array {
  const decoder = new RecordStreamDecoder(cipher);
  const parts = decoder.push(stream);
  decoder.finish();
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// Inner request / response
// ---------------------------------------------------------------------------

export type InnerRequest = {
  method: string;
  /** Must start with `/` and must not be `/v2/sealed`. */
  path: string;
  /** Raw query without `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
};

export type InnerResponseHead = {
  status: number;
  headers: Record<string, string>;
};

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

export function validateInnerPath(path: string): void {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new TypeError('inner request path must start with "/" and carry no query');
  }
  if (path === TRANSPORT_V2_SEALED_PATH || path.startsWith(`${TRANSPORT_V2_SEALED_PATH}/`)) {
    throw new TypeError('inner request must not target /v2/sealed');
  }
}

/** `u32_be(len(head)) || head || body` with the JSON request head. */
export function encodeInnerRequest(request: InnerRequest): Uint8Array {
  validateInnerPath(request.path);
  const head: Record<string, unknown> = { method: request.method.toUpperCase(), path: request.path };
  const query = (request.query ?? '').replace(/^\?/, '');
  if (query) head.query = query;
  head.headers = normalizeHeaders(request.headers);
  const headBytes = encoder.encode(JSON.stringify(head));
  return concat(u32be(headBytes.length), headBytes, request.body ?? new Uint8Array());
}

/** Parses an inner request (server-side helper, used by tests and fakes). */
export function decodeInnerRequest(plaintext: Uint8Array): Required<InnerRequest> {
  const { head, body } = splitHead(plaintext);
  const value = head as Partial<InnerRequest> | null;
  if (
    !value
    || typeof value.method !== 'string'
    || typeof value.path !== 'string'
    || (value.query !== undefined && typeof value.query !== 'string')
    || !isStringRecord(value.headers)
  ) {
    throw new TransportCryptoError('malformed inner request head');
  }
  try {
    validateInnerPath(value.path);
  } catch {
    throw new TransportCryptoError('invalid inner request path');
  }
  return {
    method: value.method,
    path: value.path,
    query: value.query ?? '',
    headers: value.headers as Record<string, string>,
    body,
  };
}

export function encodeInnerResponse(head: InnerResponseHead, body: Uint8Array = new Uint8Array()): Uint8Array {
  const headBytes = encoder.encode(JSON.stringify({ status: head.status, headers: normalizeHeaders(head.headers) }));
  return concat(u32be(headBytes.length), headBytes, body);
}

function parseResponseHead(value: unknown): InnerResponseHead {
  const head = value as Partial<InnerResponseHead> | null;
  if (
    !head
    || typeof head.status !== 'number'
    || !Number.isInteger(head.status)
    || head.status < 100
    || head.status > 599
    || !isStringRecord(head.headers)
  ) {
    throw new TransportCryptoError('malformed inner response head');
  }
  return { status: head.status, headers: head.headers as Record<string, string> };
}

export function decodeInnerResponse(plaintext: Uint8Array): InnerResponseHead & { body: Uint8Array } {
  const { head, body } = splitHead(plaintext);
  return { ...parseResponseHead(head), body };
}

function isStringRecord(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

function headLength(bytes: Uint8Array): number {
  const length = readU32be(bytes, 0);
  if (length > TRANSPORT_V2_MAX_HEAD_BYTES) {
    throw new TransportCryptoError('inner head too large');
  }
  return length;
}

function parseHeadJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strictDecoder.decode(bytes));
  } catch {
    throw new TransportCryptoError('inner head is not JSON');
  }
}

function splitHead(plaintext: Uint8Array): { head: unknown; body: Uint8Array } {
  if (plaintext.length < 4) throw new TransportCryptoError('inner message too short');
  const length = headLength(plaintext);
  if (plaintext.length < 4 + length) throw new TransportCryptoError('inner head truncated');
  return {
    head: parseHeadJson(plaintext.subarray(4, 4 + length)),
    body: plaintext.slice(4 + length),
  };
}

// ---------------------------------------------------------------------------
// REST tunnel (client side)
// ---------------------------------------------------------------------------

export type RestSealOptions = {
  protocol: SecureTransportProtocol;
  serverPublicKey: Uint8Array | string;
  request: InnerRequest;
  /** Plaintext body limit for the pre-check; omitted = unchecked. */
  maxBodyBytes?: number;
  randomness?: ClientHandshakeRandomness & { clientNonce?: Uint8Array };
};

/** Keeps `k_down` for the response of one sealed request. */
export type RestResponseContext = {
  readonly protocol: SecureTransportProtocol;
  /** Takes ownership of the response key; second use throws. */
  takeResponseCipher: () => RecordCipher;
  dispose: () => void;
};

export type SealedRestRequest = {
  /** Outer request headers (lowercase names). */
  headers: Record<string, string>;
  /** Outer request body (record stream sealed with `k_up`). */
  body: Uint8Array;
  context: RestResponseContext;
};

/** Builds the outer `POST /v2/sealed` request for one inner request. */
export function sealRestRequest(options: RestSealOptions): SealedRestRequest {
  const { protocol } = options;
  const body = options.request.body ?? new Uint8Array();
  if (options.maxBodyBytes !== undefined) assertPlaintextFits(body.length, options.maxBodyBytes);
  const plaintext = encodeInnerRequest(options.request);
  const serverStaticPublic = decodeKey(options.serverPublicKey);
  const clientNonce = options.randomness?.clientNonce
    ? Uint8Array.from(options.randomness.clientNonce)
    : randomBytes(TRANSPORT_V2_NONCE_LENGTH);
  if (clientNonce.length !== TRANSPORT_V2_NONCE_LENGTH) {
    throw new TransportCryptoError('client nonce length');
  }
  const handshake = clientHandshake(protocol, serverStaticPublic, options.randomness);
  let keys: TransportKeys;
  try {
    keys = deriveTransportKeys({
      label: TRANSPORT_V2_REST_LABEL,
      protocol,
      deviceId: '',
      serverStaticPublic,
      clientMaterial: handshake.clientMaterial,
      clientNonce,
      serverNonce: new Uint8Array(),
      shared: handshake.shared,
    });
  } finally {
    wipe(handshake.shared);
  }
  const up = new RecordCipher(keys.kUp, keys.th, TRANSPORT_V2_DIRECTION_UP);
  let down: RecordCipher | null = new RecordCipher(keys.kDown, keys.th, TRANSPORT_V2_DIRECTION_DOWN);
  wipe(keys.kUp, keys.kDown, keys.th);
  let sealedBody: Uint8Array;
  try {
    sealedBody = sealRecordStream(up, plaintext);
  } finally {
    up.dispose();
    wipe(plaintext);
  }
  return {
    headers: {
      'content-type': TRANSPORT_V2_SEALED_CONTENT_TYPE,
      [TRANSPORT_V2_HEADERS.transport]: String(TRANSPORT_V2_VERSION),
      [TRANSPORT_V2_HEADERS.encryption]: protocol,
      [protocol === 'x25519' ? TRANSPORT_V2_HEADERS.clientKey : TRANSPORT_V2_HEADERS.kemCiphertext]:
        encodeBase64Url(handshake.clientMaterial),
      [TRANSPORT_V2_HEADERS.requestNonce]: encodeBase64Url(clientNonce),
    },
    body: sealedBody,
    context: {
      protocol,
      takeResponseCipher: () => {
        if (!down) throw new TransportCryptoError('response already opened');
        const cipher = down;
        down = null;
        return cipher;
      },
      dispose: () => {
        down?.dispose();
        down = null;
      },
    },
  };
}

/** Opens a complete sealed response body (one-shot). */
export function openRestResponse(
  context: RestResponseContext,
  body: Uint8Array,
): InnerResponseHead & { body: Uint8Array } {
  const cipher = context.takeResponseCipher();
  try {
    return decodeInnerResponse(openRecordStream(cipher, body));
  } finally {
    cipher.dispose();
  }
}

export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** Iterates a `ReadableStream`, async iterable or array of chunks; cancels the stream when abandoned. */
export async function* iterateByteSource(source: ByteSource): AsyncGenerator<Uint8Array> {
  const stream = source as ReadableStream<Uint8Array>;
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Stops the network read when the consumer bails out early.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  yield* source as AsyncIterable<Uint8Array>;
}

export type StreamingRestResponse = InnerResponseHead & {
  /**
   * Inner body chunks, decrypted record by record. Throws
   * `TransportCryptoError` on tampering, truncation or trailing bytes; the
   * error surfaces after the chunks authenticated before it.
   */
  body: AsyncIterable<Uint8Array>;
};

/**
 * Opens a streamed sealed response: resolves once the inner head has been
 * authenticated, then yields body chunks as records arrive.
 */
export async function openRestResponseStream(
  context: RestResponseContext,
  source: ByteSource,
): Promise<StreamingRestResponse> {
  const cipher = context.takeResponseCipher();
  const decoder = new RecordStreamDecoder(cipher);
  const iterator = iterateByteSource(source)[Symbol.asyncIterator]();
  let pending: Uint8Array = new Uint8Array(0);
  let head: InnerResponseHead | null = null;
  let headBytes = -1;
  let finished = false;

  const fail = async (error: unknown): Promise<never> => {
    decoder.dispose();
    await iterator.return?.(undefined).catch(() => undefined);
    throw error;
  };

  const pull = async (): Promise<Uint8Array[] | null> => {
    const next = await iterator.next();
    if (next.done) {
      decoder.finish();
      finished = true;
      decoder.dispose();
      return null;
    }
    return decoder.push(next.value);
  };

  try {
    while (!head) {
      const records = await pull();
      if (records === null) {
        throw new TransportCryptoError('truncated before inner head');
      }
      if (records.length) pending = concat(pending, ...records);
      if (headBytes < 0 && pending.length >= 4) headBytes = headLength(pending);
      if (headBytes >= 0 && pending.length >= 4 + headBytes) {
        head = parseResponseHead(parseHeadJson(pending.subarray(4, 4 + headBytes)));
        pending = pending.slice(4 + headBytes);
      }
    }
  } catch (error) {
    return fail(error);
  }

  const firstChunk = pending;
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      if (firstChunk.length) yield firstChunk;
      while (!finished) {
        const records = await pull();
        for (const record of records ?? []) {
          if (record.length) yield record;
        }
      }
    } finally {
      // Error, early `return()` by the consumer, or a failed `finish()`:
      // wipe the key and stop reading the network body.
      if (!finished) {
        decoder.dispose();
        await iterator.return?.(undefined).catch(() => undefined);
      }
    }
  }

  return { ...head, body: body() };
}

// ---------------------------------------------------------------------------
// Device pairing v3 (client side)
// ---------------------------------------------------------------------------

export const DEVICE_PAIRING_V3_COMMIT_LABEL = 'todex.device-pairing.v3/commit';
export const DEVICE_PAIRING_V3_TRANSCRIPT_DOMAIN = 'todex.device-pairing.v3/transcript\0';
export const DEVICE_PAIRING_V3_WRAP_INFO = 'todex.device-pairing.v3/wrap-key';
export const DEVICE_PAIRING_V3_POLL_INFO = 'todex.device-pairing.v3/poll-proof';
export const DEVICE_PAIRING_V3_CANCEL_INFO = 'todex.device-pairing.v3/cancel-proof';
/** The spec leaves the pairing nonce length open; v3 clients send 32 bytes. */
export const DEVICE_PAIRING_V3_NONCE_LENGTH = 32;

/** `SHA256(LP("todex.device-pairing.v3/commit") || client_public || client_nonce)`. */
export function devicePairingV3Commitment(clientPublic: Uint8Array, clientNonce: Uint8Array): Uint8Array {
  requirePairingLengths(clientPublic, clientNonce);
  return sha256(concat(lengthPrefixed(encoder.encode(DEVICE_PAIRING_V3_COMMIT_LABEL)), clientPublic, clientNonce));
}

export function devicePairingV3Transcript(input: {
  requestId: string;
  clientPublic: Uint8Array;
  serverPublic: Uint8Array;
  devicePublic: Uint8Array;
  clientNonce: Uint8Array;
}): Uint8Array {
  requirePairingLengths(input.clientPublic, input.clientNonce);
  if (input.serverPublic.length !== 32 || input.devicePublic.length !== 32) {
    throw new TypeError('pairing keys must be 32 bytes');
  }
  return concat(
    encoder.encode(DEVICE_PAIRING_V3_TRANSCRIPT_DOMAIN),
    encoder.encode(input.requestId),
    Uint8Array.of(0),
    input.clientPublic,
    input.serverPublic,
    Uint8Array.of(0),
    input.devicePublic,
    input.clientNonce,
  );
}

export type DevicePairingV3Material = {
  transcript: Uint8Array;
  transcriptHash: Uint8Array;
  /** `XXXXX-XXXXX`, the first 5 bytes of `SHA256(transcript)` in upper hex. */
  verificationCode: string;
  wrapKey: Uint8Array;
  pollProof: Uint8Array;
  cancelProof: Uint8Array;
};

/**
 * Client view of the v3 pairing material: X25519 between the client's
 * ephemeral secret and the server's per-request public key, then
 * HKDF-SHA256(salt = SHA256(transcript)) with the three v3 labels (the v2
 * pattern from the backend's `device_pairing.rs`).
 */
export function deriveDevicePairingV3Material(input: {
  requestId: string;
  clientSecretKey: Uint8Array;
  serverPublic: Uint8Array;
  devicePublic: Uint8Array;
  clientNonce: Uint8Array;
}): DevicePairingV3Material {
  const clientPublic = x25519.getPublicKey(input.clientSecretKey);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(input.clientSecretKey, input.serverPublic);
  } catch {
    throw new TransportCryptoError('pairing shared secret');
  }
  try {
    if (isAllZero(shared)) throw new TransportCryptoError('pairing shared secret is zero');
    const transcript = devicePairingV3Transcript({ ...input, clientPublic });
    const transcriptHash = sha256(transcript);
    const prk = extract(sha256, shared, transcriptHash);
    try {
      const short = Array.from(transcriptHash.subarray(0, 5), (byte) =>
        byte.toString(16).toUpperCase().padStart(2, '0')).join('');
      return {
        transcript,
        transcriptHash,
        verificationCode: `${short.slice(0, 5)}-${short.slice(5)}`,
        wrapKey: expand(sha256, prk, encoder.encode(DEVICE_PAIRING_V3_WRAP_INFO), 32),
        pollProof: expand(sha256, prk, encoder.encode(DEVICE_PAIRING_V3_POLL_INFO), 32),
        cancelProof: expand(sha256, prk, encoder.encode(DEVICE_PAIRING_V3_CANCEL_INFO), 32),
      };
    } finally {
      wipe(prk);
    }
  } finally {
    wipe(shared);
  }
}

function requirePairingLengths(clientPublic: Uint8Array, clientNonce: Uint8Array): void {
  if (clientPublic.length !== 32) throw new TypeError('pairing client public key must be 32 bytes');
  if (clientNonce.length !== DEVICE_PAIRING_V3_NONCE_LENGTH) {
    throw new TypeError(`pairing client nonce must be ${DEVICE_PAIRING_V3_NONCE_LENGTH} bytes`);
  }
}
