import { ConnectionError, ConnectionErrorType } from './connectionError';
import { deviceAuthHeaders, deviceAuthQuery, type DeviceIdentity } from './deviceAuth';
import { isLoopbackUrl } from './mobileParity';
import {
  TRANSPORT_V2_SEALED_CONTENT_TYPE,
  TRANSPORT_V2_SEALED_PATH,
  TRANSPORT_V2_SEALED_REVISION,
  TRANSPORT_V2_WS_CLOSE_CODE,
  TRANSPORT_V2_WS_CLOSE_REASON,
  TRANSPORT_V2_VERSION,
  MAX_REST_BODY_BYTES,
  TransportCryptoError,
  assertPlaintextFits,
  assertWsPlaintextFits,
  clientHandshake,
  createWsChannel,
  iterateByteSource,
  openRestResponse,
  openRestResponseStream,
  parseSecureTransportProtocol,
  sealRestRequest,
  type ByteSource,
  type SecureTransportProtocol,
  type WsChannelHandshake,
  type WsChannelSession,
} from './secureChannel';
import { MAX_LEGACY_MESSAGE_BYTES } from './transport';
import { decodeBase64UrlBytes, type TransportEncryptionProtocol } from './transportCrypto';

// The one place business code talks to a backend. It applies the transport
// v2 "Client rules":
// - a pinned protocol + key verified by device pairing (`transportVerified`)
//   -> v2 everywhere (REST through POST /v2/sealed, WebSocket with tv=2),
//   loopback included;
// - a pinned protocol or key that pairing did not verify -> refuse
//   (`TransportRepairRequiredError`) on every host, loopback included;
// - no pinned key, remote    -> refuse (`EncryptionRequiredError`);
// - no pinned key, loopback  -> plaintext.
// A refusal never falls back to plaintext. Callers see plain requests,
// responses and JSON text messages.
//
// Sealed REST is revision 2 (`X-Todex-Sealed-Revision: 2`, responses typed
// `application/vnd.todex.sealed; r=2` and prefixed with a response nonce). A
// sealed answer without `r=2` comes from an outdated backend
// (`BackendUpgradeRequiredError`). Two authenticated inner answers are
// retried once with a fresh signature: `503 TRANSPORT_BUSY` (the backend
// guarantees the request did not run) after `Retry-After`, and `401
// AUTH_TIMESTAMP_REJECTED` after recording the backend's clock offset from
// its `serverTime`.

export type SecureTransportProfile = {
  serverUrl: string;
  encryptionProtocol: TransportEncryptionProtocol;
  /** Pinned server static public key (base64url); empty when unpaired. */
  encryptionPublicKey: string;
  /**
   * True only when device pairing v3 verified the pinned protocol and key
   * (`verifyDevicePairingCredential`). A pinned profile without it must be
   * re-paired.
   */
  transportVerified?: boolean;
};

export type SecureTransportMode = 'v2' | 'plaintext' | 'refused';

/** What the device-auth signer covers: always the *inner* request. */
export type SignableRequest = { method: string; path: string; query: string; body: Uint8Array };

/** Signing time: local time corrected by the backend's clock offset. */
export type SigningClock = { nowMs: number };

export type DeviceRequestSigner = {
  /** Device id the credentials carry; bound into the WebSocket key schedule. */
  deviceId: string;
  /** Device-auth headers for a REST request. */
  signRequest: (request: SignableRequest, clock?: SigningClock) => Record<string, string>;
  /** Device-auth query parameters for the WebSocket upgrade (`GET`, empty body). */
  signUpgrade: (request: { path: string; query: string }, clock?: SigningClock) => Record<string, string>;
};

/** Signer backed by `deviceAuth.ts` (`todex.device-auth.v1`). */
export function deviceRequestSigner(device: DeviceIdentity): DeviceRequestSigner {
  return {
    deviceId: device.deviceId,
    signRequest: ({ method, path, query, body }, clock) =>
      deviceAuthHeaders(device, method, query ? `${path}?${query}` : path, body, { now: clock?.nowMs }),
    signUpgrade: ({ path, query }, clock) => deviceAuthQuery(device, 'GET', path, query, { now: clock?.nowMs }),
  };
}

const CLOCK_OFFSET_LIMIT = 32;
const clockOffsets = new Map<string, number>();

function clockKey(serverUrl: string): string {
  return httpServerUrl(serverUrl).replace(/\/+$/, '').toLowerCase();
}

/**
 * Milliseconds to add to local time when signing for `serverUrl`, learned
 * from the backend's `serverTime` in an authenticated `401
 * AUTH_TIMESTAMP_REJECTED`; 0 until then.
 */
export function backendClockOffsetMs(serverUrl: string): number {
  return clockOffsets.get(clockKey(serverUrl)) ?? 0;
}

function recordClockOffset(serverUrl: string, serverTimeSeconds: number, nowMs = Date.now()): void {
  const key = clockKey(serverUrl);
  clockOffsets.delete(key);
  if (clockOffsets.size >= CLOCK_OFFSET_LIMIT) {
    const oldest = clockOffsets.keys().next().value;
    if (oldest !== undefined) clockOffsets.delete(oldest);
  }
  clockOffsets.set(key, serverTimeSeconds * 1000 - nowMs);
}

export type SecureTransportOptions = {
  profile: SecureTransportProfile;
  /** Injected `fetch` (Electron/browser/tests). Defaults to the global one. */
  fetchImpl?: typeof fetch;
  /** Injected WebSocket constructor. Defaults to the global one. */
  WebSocketImpl?: typeof WebSocket;
  /** Omit when the backend runs with auth disabled. */
  signer?: DeviceRequestSigner | null;
  /** Encrypted/plaintext WebSocket frame limit for the pre-check. */
  maxFrameBytes?: number;
  /** REST request body limit for the pre-check (defaults to `MAX_REST_BODY_BYTES`). */
  maxBodyBytes?: number;
};

export type SecureRequest = {
  method: string;
  /** Absolute API path, e.g. `/v2/workspaces`. */
  path: string;
  query?: string | URLSearchParams | Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
};

export type SecureResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
export type SecureStreamResponse = {
  status: number;
  headers: Record<string, string>;
  /** Consume to the end (or call `return()`) so keys are wiped and the read stops. */
  body: AsyncIterable<Uint8Array>;
};

export type SecureSocketHandlers = {
  /** v2: after the server hello; plaintext: on socket open. */
  onOpen?: () => void;
  onMessage?: (text: string) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  /** `TransportCryptoError` already closed the socket with 4400. */
  onError?: (error: Error) => void;
};

export type SecureSocketOptions = SecureSocketHandlers & {
  /** Defaults to `/v2/ws`. */
  path?: string;
  /** Extra upgrade query parameters (e.g. `historyEncryption`). */
  query?: Record<string, string>;
};

export type SecureSocket = {
  readonly encrypted: boolean;
  /** True once `onOpen` fired and until the socket closes. */
  readonly ready: boolean;
  /** True once the socket closed, failed or `close()` was called. */
  readonly closed: boolean;
  /** Sends one JSON text message; throws `TransportPayloadTooLargeError` before sealing when too large. */
  send: (text: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type SecureTransport = {
  readonly mode: SecureTransportMode;
  /** Throws `TransportPayloadTooLargeError` before sending a body over the limit. */
  fetch: (request: SecureRequest) => Promise<SecureResponse>;
  fetchStream: (request: SecureRequest) => Promise<SecureStreamResponse>;
  openSocket: (options?: SecureSocketOptions) => SecureSocket;
};

/** Remote host without a pinned key: the user must pair with encryption. */
export class EncryptionRequiredError extends ConnectionError {
  constructor(serverUrl: string) {
    super(
      ConnectionErrorType.ENCRYPTION_REQUIRED,
      '远程后端必须使用加密连接，请重新配对',
      `no pinned transport key for non-loopback host ${serverUrl}`,
      false,
      'encryption_required',
    );
    this.name = 'EncryptionRequiredError';
  }
}

/**
 * The pinned transport cannot be used until the device pairs again: the
 * server now requires a different protocol than the one pinned at pairing,
 * or (`required === null`) the pinned protocol/key was never verified by
 * device pairing, e.g. a profile from before pairing bound the transport key.
 */
export class TransportRepairRequiredError extends ConnectionError {
  constructor(readonly pinned: string, readonly required: string | null) {
    super(
      ConnectionErrorType.ENCRYPTION_REQUIRED,
      required === null ? '加密公钥未经设备配对验证，请重新配对' : '后端的加密方式已变更，请重新配对',
      required === null
        ? `pinned ${pinned} transport was not verified by device pairing`
        : `pinned ${pinned}, server requires ${required}`,
      false,
      'encryption_required',
    );
    this.name = 'TransportRepairRequiredError';
  }
}

/**
 * The backend predates sealed REST revision 2: its `/v2/transport-policy`
 * lacks `"sealedRevision": 2`, or it answered a sealed request without
 * `r=2`. Never falls back; the backend must be updated.
 */
export class BackendUpgradeRequiredError extends ConnectionError {
  constructor(readonly detail: 'policy' | 'response') {
    super(
      ConnectionErrorType.PROTOCOL_MISMATCH,
      '后端版本过旧，请升级后端后重新连接',
      detail === 'policy'
        ? `transport policy lacks sealedRevision ${TRANSPORT_V2_SEALED_REVISION}`
        : `sealed response without r=${TRANSPORT_V2_SEALED_REVISION}`,
      false,
      'protocol_mismatch',
    );
    this.name = 'BackendUpgradeRequiredError';
  }
}

/** The pinned key cannot be used (malformed, wrong length or a low-order point). */
export class InvalidPinnedKeyError extends ConnectionError {
  constructor(readonly protocol: string) {
    super(
      ConnectionErrorType.ENCRYPTION_REQUIRED,
      '已保存的加密公钥无效，请重新配对',
      `pinned ${protocol} key is unusable`,
      false,
      'encryption_required',
    );
    this.name = 'InvalidPinnedKeyError';
  }
}

/** Runs one throwaway key agreement against the pinned key; throws `InvalidPinnedKeyError`. */
export function assertPinnedKeyUsable(profile: SecureTransportProfile): void {
  const protocol = pinnedProtocol(profile);
  if (!protocol) return;
  let shared: Uint8Array | undefined;
  try {
    shared = clientHandshake(protocol, decodeBase64UrlBytes(profile.encryptionPublicKey.trim())).shared;
  } catch {
    throw new InvalidPinnedKeyError(protocol);
  } finally {
    shared?.fill(0);
  }
}

function pinnedProtocol(profile: SecureTransportProfile): SecureTransportProtocol | null {
  const protocol = parseSecureTransportProtocol(profile.encryptionProtocol);
  return protocol && (profile.encryptionPublicKey ?? '').trim() ? protocol : null;
}

/** Any trace of a pin: a protocol other than `none`, or a non-empty key. */
function hasPin(profile: SecureTransportProfile): boolean {
  return (profile.encryptionProtocol ?? 'none') !== 'none' || Boolean((profile.encryptionPublicKey ?? '').trim());
}

/** `ws(s)://` server URLs are accepted for the HTTP origin they name. */
function httpServerUrl(serverUrl: string): string {
  return (serverUrl ?? '').trim().replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
}

export function secureTransportMode(profile: SecureTransportProfile): SecureTransportMode {
  return secureTransportRefusal(profile)
    ? 'refused'
    : pinnedProtocol(profile) ? 'v2' : 'plaintext';
}

/**
 * Why a profile is `refused`, or null when it may connect:
 * `TransportRepairRequiredError` for an unverified pin,
 * `InvalidPinnedKeyError` for a verified but incomplete pin (a protocol
 * without a key or a key without a protocol), `EncryptionRequiredError` for
 * an unpinned remote host.
 */
export function secureTransportRefusal(profile: SecureTransportProfile): ConnectionError | null {
  if (hasPin(profile)) {
    const protocol = pinnedProtocol(profile);
    if (profile.transportVerified !== true) {
      return new TransportRepairRequiredError(protocol ?? String(profile.encryptionProtocol ?? 'none'), null);
    }
    return protocol ? null : new InvalidPinnedKeyError(String(profile.encryptionProtocol ?? 'none'));
  }
  return isLoopbackUrl(httpServerUrl(profile.serverUrl)) ? null : new EncryptionRequiredError(profile.serverUrl);
}

/**
 * Checks a `/v2/transport-policy` answer against the profile. The answer
 * never downgrades a pinned profile to plaintext: a pinned profile whose
 * server now requires another protocol (including `none`, which has no
 * static key to run v2 against) must be re-paired, and one whose server does
 * not report `sealedRevision: 2` needs a backend update.
 */
export function checkTransportPolicy(
  profile: SecureTransportProfile,
  policy: { requiredProtocol?: unknown; transportVersion?: unknown; sealedRevision?: unknown },
): void {
  const refusal = secureTransportRefusal(profile);
  if (refusal) throw refusal;
  const pinned = pinnedProtocol(profile);
  if (!pinned) return;
  const required = policy.requiredProtocol === 'none' ? 'none' : parseSecureTransportProtocol(policy.requiredProtocol);
  if (required && required !== pinned) {
    throw new TransportRepairRequiredError(pinned, required);
  }
  if (policy.transportVersion !== TRANSPORT_V2_VERSION) {
    throw new TransportPolicyError('outdated', false);
  }
  if (policy.sealedRevision !== TRANSPORT_V2_SEALED_REVISION) {
    throw new BackendUpgradeRequiredError('policy');
  }
}

/** Why `/v2/transport-policy` could not confirm the profile. */
export type TransportPolicyFailure = 'unreachable' | 'timeout' | 'http' | 'invalid' | 'outdated';

export class TransportPolicyError extends Error {
  constructor(readonly reason: TransportPolicyFailure, readonly retryable: boolean, readonly status?: number) {
    super(`transport policy check failed: ${reason}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'TransportPolicyError';
  }
}

const POLICY_TIMEOUT_MS = 10_000;
const POLICY_MAX_BYTES = 2048;

/**
 * Runs the connect-time policy check: refuses an unpaired remote or an
 * unverified pinned profile without touching the network, then reads `/v2/transport-policy` (direct
 * and unsigned: it is on the plaintext allow-list and carries no secrets)
 * and applies `checkTransportPolicy`. Rejects with `EncryptionRequiredError`,
 * `InvalidPinnedKeyError`, `TransportRepairRequiredError`,
 * `TransportPolicyError`, `BackendUpgradeRequiredError`, or an `AbortError`
 * when `signal` aborts.
 */
export async function verifyTransportPolicy(
  profile: SecureTransportProfile,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const refusal = secureTransportRefusal(profile);
  if (refusal) throw refusal;
  assertPinnedKeyUsable(profile);
  const { signal } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? POLICY_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);
  let value: unknown;
  try {
    let response: Response;
    try {
      response = await fetchImpl(originUrl(httpServerUrl(profile.serverUrl), '/v2/transport-policy'), {
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransportPolicyError(controller.signal.aborted ? 'timeout' : 'unreachable', true);
    }
    // A backend without the policy route predates transport v2.
    if (response.status === 404) throw new TransportPolicyError('outdated', false, 404);
    if (!response.ok) throw new TransportPolicyError('http', response.status >= 500, response.status);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TransportPolicyError(controller.signal.aborted ? 'timeout' : 'unreachable', true);
    }
    if (text.length > POLICY_MAX_BYTES) throw new TransportPolicyError('invalid', false);
    try {
      value = JSON.parse(text);
    } catch {
      throw new TransportPolicyError('invalid', false);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const policy = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const required = policy?.requiredProtocol;
  if (required !== 'none' && !parseSecureTransportProtocol(required)) {
    throw new TransportPolicyError('invalid', false);
  }
  checkTransportPolicy(profile, policy as { requiredProtocol?: unknown; transportVersion?: unknown; sealedRevision?: unknown });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function queryString(query: SecureRequest['query']): string {
  if (!query) return '';
  if (typeof query === 'string') return query.replace(/^\?/, '');
  return (query instanceof URLSearchParams ? query : new URLSearchParams(query)).toString();
}

function bodyBytes(body: SecureRequest['body']): Uint8Array {
  if (body === undefined) return new Uint8Array();
  return typeof body === 'string' ? encoder.encode(body) : body;
}

function originUrl(serverUrl: string, path: string, query = ''): string {
  const url = new URL(path, serverUrl.replace(/\/+$/, '') + '/');
  url.search = query;
  return url.toString();
}

function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

/** `type/subtype; name=value` -> lowercase media type and parameters (first wins, quotes removed). */
function parseContentType(value: string | null): { media: string; params: Map<string, string> } {
  const [media, ...parts] = (value ?? '').split(';');
  const params = new Map<string, string>();
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    let parameter = part.slice(at + 1).trim();
    if (parameter.length >= 2 && parameter.startsWith('"') && parameter.endsWith('"')) parameter = parameter.slice(1, -1);
    if (name && !params.has(name)) params.set(name, parameter);
  }
  return { media: media.trim().toLowerCase(), params };
}

/** Error answers worth inspecting are small JSON; a larger body is passed through untouched. */
const ERROR_BODY_PEEK_BYTES = 64 * 1024;
/** Upper bound for honouring `Retry-After` on `TRANSPORT_BUSY`. */
const BUSY_RETRY_MAX_DELAY_MS = 5000;
const BUSY_RETRY_DEFAULT_DELAY_MS = 1000;

/** `{"code", "message", "serverTime"}`: the backend's top-level error body. */
function parseErrorEnvelope(body: Uint8Array): { code?: string; serverTime?: number } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const envelope = value as Record<string, unknown>;
  const serverTime = envelope.serverTime;
  return {
    code: typeof envelope.code === 'string' ? envelope.code : undefined,
    serverTime: typeof serverTime === 'number' && Number.isSafeInteger(serverTime) && serverTime > 0 ? serverTime : undefined,
  };
}

/** `Retry-After` in delta-seconds, capped; anything else waits the default second. */
function busyRetryDelayMs(value: string | undefined): number {
  const trimmed = (value ?? '').trim();
  if (!/^\d{1,6}$/.test(trimmed)) return BUSY_RETRY_DEFAULT_DELAY_MS;
  return Math.min(Number(trimmed) * 1000, BUSY_RETRY_MAX_DELAY_MS);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reads a streamed body up to `limit` bytes. Returns its bytes when it ended
 * within the limit (null otherwise) and an iterable that replays everything,
 * including whatever was not read yet.
 */
async function peekStreamBody(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array | null; body: AsyncIterable<Uint8Array> }> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= limit) {
    const next = await iterator.next();
    if (next.done) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { bytes, body: iterateByteSource(chunks) };
    }
    chunks.push(next.value);
    size += next.value.length;
  }
  async function* replay(): AsyncGenerator<Uint8Array> {
    yield* chunks;
    yield* { [Symbol.asyncIterator]: () => iterator };
  }
  return { bytes: null, body: replay() };
}

async function rejectUnsealed(response: Response): Promise<never> {
  // Never treat an unsealed answer to a sealed request as the inner response:
  // it is unauthenticated. Surface it as a request failure instead.
  const envelope = await response.json().catch(() => null) as
    | { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown }
    | null;
  const error = envelope?.error ?? envelope;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : undefined;
  throw ConnectionError.apiRequestFailed(response.status, code, message);
}

function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function createSecureTransport(options: SecureTransportOptions): SecureTransport {
  const profile = { ...options.profile, serverUrl: httpServerUrl(options.profile.serverUrl) };
  const mode = secureTransportMode(profile);
  const signer = options.signer ?? null;
  const maxFrameBytes = options.maxFrameBytes ?? MAX_LEGACY_MESSAGE_BYTES;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_REST_BODY_BYTES;
  const fetchImpl = (): typeof fetch => {
    if (options.fetchImpl) return options.fetchImpl;
    // Browser fetch requires its Window receiver when called detached.
    return typeof window !== 'undefined' ? fetch.bind(window) : fetch;
  };
  const requireAllowed = (): void => {
    const refusal = mode === 'refused' ? secureTransportRefusal(profile) : null;
    if (refusal) throw refusal;
  };

  const signingClock = (): SigningClock => ({ nowMs: Date.now() + backendClockOffsetMs(profile.serverUrl) });

  const prepare = (request: SecureRequest) => {
    const query = queryString(request.query);
    const body = bodyBytes(request.body);
    const method = request.method.toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value;
    return { method, path: request.path, query, body, headers };
  };
  type PreparedRequest = ReturnType<typeof prepare>;

  /** Every attempt signs afresh: new nonce, current (offset-corrected) time. */
  const signed = (inner: PreparedRequest): PreparedRequest => {
    if (!signer) return inner;
    const { method, path, query, body } = inner;
    return { ...inner, headers: { ...inner.headers, ...signer.signRequest({ method, path, query, body }, signingClock()) } };
  };

  const attempt = async (
    request: SecureRequest,
    prepared: PreparedRequest,
    streaming: boolean,
  ): Promise<SecureResponse | SecureStreamResponse> => {
    const inner = signed(prepared);
    if (mode === 'plaintext') {
      const response = await fetchImpl()(originUrl(profile.serverUrl, inner.path, inner.query), {
        method: inner.method,
        headers: inner.headers,
        body: inner.body.length || !['GET', 'HEAD'].includes(inner.method)
          ? inner.body as Uint8Array<ArrayBuffer>
          : undefined,
        // A redirect would replay the signed request to another URL.
        redirect: 'error',
        signal: request.signal,
      });
      const headers = headersRecord(response.headers);
      if (streaming && response.body) {
        return { status: response.status, headers, body: iterateByteSource(response.body) };
      }
      const body = new Uint8Array(await response.arrayBuffer());
      return streaming
        ? { status: response.status, headers, body: iterateByteSource(body.length ? [body] : []) }
        : { status: response.status, headers, body };
    }

    const protocol = pinnedProtocol(profile) as SecureTransportProtocol;
    const sealed = sealRestRequest({
      protocol,
      serverPublicKey: profile.encryptionPublicKey,
      request: inner,
    });
    let response: Response;
    try {
      response = await fetchImpl()(originUrl(profile.serverUrl, TRANSPORT_V2_SEALED_PATH), {
        method: 'POST',
        headers: sealed.headers,
        body: sealed.body as Uint8Array<ArrayBuffer>,
        // The backend never redirects `/v2/sealed`; following one would hand
        // the sealed request to whatever the redirect names.
        redirect: 'error',
        signal: request.signal,
      });
    } catch (error) {
      sealed.context.dispose();
      throw error;
    }
    const contentType = parseContentType(response.headers.get('content-type'));
    const sealedType = contentType.media === TRANSPORT_V2_SEALED_CONTENT_TYPE;
    if (sealedType && contentType.params.get('r') !== String(TRANSPORT_V2_SEALED_REVISION)) {
      // A sealed answer of an older revision: the backend must be updated.
      sealed.context.dispose();
      await response.body?.cancel().catch(() => undefined);
      throw new BackendUpgradeRequiredError('response');
    }
    if (response.status !== 200 || !sealedType) {
      sealed.context.dispose();
      return rejectUnsealed(response);
    }
    if (streaming && response.body) {
      return openRestResponseStream(sealed.context, response.body as ByteSource);
    }
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      sealed.context.dispose();
      throw error;
    }
    if (streaming) return openRestResponseStream(sealed.context, [raw]);
    const opened = openRestResponse(sealed.context, raw);
    return { status: opened.status, headers: opened.headers, body: opened.body };
  };

  const send = async (request: SecureRequest, streaming: boolean): Promise<SecureResponse | SecureStreamResponse> => {
    requireAllowed();
    const prepared = prepare(request);
    // Before anything leaves: the backend answers an oversized body with an
    // opaque 400 that reads like a pairing failure.
    assertPlaintextFits(prepared.body.length, maxBodyBytes);
    let busyRetried = false;
    let clockRetried = false;
    for (;;) {
      const response = await attempt(request, prepared, streaming);
      // Only authenticated answers get here (sealed r=2, or loopback
      // plaintext); an unsealed error on the tunnel was already thrown.
      const busy = mode === 'v2' && response.status === 503 && !busyRetried;
      const clock = signer !== null && response.status === 401 && !clockRetried;
      if (!busy && !clock) return response;
      let bytes: Uint8Array | null;
      let replay: SecureResponse | SecureStreamResponse = response;
      if (streaming) {
        const peeked = await peekStreamBody(response.body as AsyncIterable<Uint8Array>, ERROR_BODY_PEEK_BYTES);
        bytes = peeked.bytes;
        replay = { ...response, body: peeked.body };
      } else {
        bytes = response.body as Uint8Array;
      }
      const envelope = bytes ? parseErrorEnvelope(bytes) : {};
      if (busy && envelope.code === 'TRANSPORT_BUSY') {
        // The backend did not run the request and did not spend the nonce.
        busyRetried = true;
        await delay(busyRetryDelayMs(response.headers['retry-after']), request.signal);
        continue;
      }
      if (clock && envelope.code === 'AUTH_TIMESTAMP_REJECTED' && envelope.serverTime !== undefined) {
        clockRetried = true;
        recordClockOffset(profile.serverUrl, envelope.serverTime);
        continue;
      }
      return replay;
    }
  };

  const openSocket = (socketOptions: SecureSocketOptions = {}): SecureSocket => {
    requireAllowed();
    const path = socketOptions.path ?? '/v2/ws';
    const params = new URLSearchParams(socketOptions.query ?? {});
    let channel: WsChannelHandshake | null = null;
    if (mode === 'v2') {
      channel = createWsChannel({
        protocol: pinnedProtocol(profile) as SecureTransportProtocol,
        serverPublicKey: profile.encryptionPublicKey,
        deviceId: signer?.deviceId ?? '',
        maxFrameBytes,
      });
      for (const [key, value] of Object.entries(channel.queryParams)) params.set(key, value);
    }
    if (signer) {
      // The signature covers the transport parameters (tv, enc, nonce, key).
      const signed = signer.signUpgrade({ path, query: params.toString() }, signingClock());
      if (signed.device_id !== undefined && signed.device_id !== signer.deviceId) {
        channel?.dispose();
        throw new TypeError('signer device id does not match its credential');
      }
      for (const [key, value] of Object.entries(signed)) params.set(key, value);
    }
    const url = new URL(originUrl(profile.serverUrl, path, params.toString()));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    const socket = new WebSocketImpl(url.toString());
    socket.binaryType = 'arraybuffer';
    let session: WsChannelSession | null = null;
    let ready = false;
    let closed = false;

    const teardown = () => {
      ready = false;
      closed = true;
      channel?.dispose();
      channel = null;
      session?.dispose();
      session = null;
    };
    const cryptoFailure = (error: unknown) => {
      if (closed) return;
      teardown();
      socket.close(TRANSPORT_V2_WS_CLOSE_CODE, TRANSPORT_V2_WS_CLOSE_REASON);
      socketOptions.onError?.(error instanceof TransportCryptoError ? error : new TransportCryptoError('socket'));
    };

    socket.onopen = () => {
      if (mode === 'plaintext') {
        ready = true;
        socketOptions.onOpen?.();
      }
      // v2: wait for the hello; the client must not send before it arrives.
    };
    socket.onmessage = (event: MessageEvent) => {
      if (closed) return;
      if (mode === 'plaintext') {
        const text = typeof event.data === 'string' ? event.data : null;
        const bytes = text === null ? frameBytes(event.data) : null;
        socketOptions.onMessage?.(text ?? decoder.decode(bytes ?? new Uint8Array()));
        return;
      }
      let text: string;
      try {
        if (!session) {
          if (typeof event.data !== 'string' || !channel) throw new TransportCryptoError('expected hello');
          session = channel.acceptHello(event.data);
          channel = null;
          ready = true;
          socketOptions.onOpen?.();
          return;
        }
        const bytes = frameBytes(event.data);
        if (!bytes) throw new TransportCryptoError('expected binary frame');
        text = session.open(bytes);
      } catch (error) {
        cryptoFailure(error);
        return;
      }
      socketOptions.onMessage?.(text);
    };
    socket.onerror = () => {
      if (!closed) socketOptions.onError?.(ConnectionError.websocketFailed('WebSocket error'));
    };
    socket.onclose = (event: CloseEvent) => {
      teardown();
      socketOptions.onClose?.({ code: event.code, reason: event.reason });
    };

    return {
      encrypted: mode === 'v2',
      get ready() {
        return ready;
      },
      get closed() {
        return closed;
      },
      send: (text: string) => {
        if (!ready) throw new Error('secure socket is not open');
        if (session) {
          socket.send(session.seal(text) as Uint8Array<ArrayBuffer>);
          return;
        }
        assertWsPlaintextFits(text, maxFrameBytes);
        socket.send(text);
      },
      close: (code?: number, reason?: string) => {
        teardown();
        socket.close(code, reason);
      },
    };
  };

  return {
    mode,
    fetch: (request) => send(request, false) as Promise<SecureResponse>,
    fetchStream: (request) => send(request, true) as Promise<SecureStreamResponse>,
    openSocket,
  };
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Wraps an opened response as a standard `Response`, so callers written
 * against `fetch` keep using `ok`, `status`, `json()` and `text()`.
 */
export function toFetchResponse(response: SecureResponse): Response {
  const body = NULL_BODY_STATUSES.has(response.status) ? null : response.body as Uint8Array<ArrayBuffer>;
  return new Response(body, { status: response.status, headers: response.headers });
}

const TRANSPORT_CACHE_LIMIT = 8;
const transportCache = new Map<string, SecureTransport>();

/**
 * One `SecureTransport` per backend profile (server URL, pinned protocol,
 * key and verification flag, device). A changed profile yields a new instance; the previous one for
 * the same server is dropped. Instances hold no per-request state, so sharing
 * them across callers is safe.
 */
export function cachedSecureTransport(
  profile: SecureTransportProfile,
  device: DeviceIdentity | null,
): SecureTransport {
  const normalized: SecureTransportProfile = {
    serverUrl: httpServerUrl(profile.serverUrl).replace(/\/+$/, ''),
    encryptionProtocol: profile.encryptionProtocol,
    encryptionPublicKey: (profile.encryptionPublicKey ?? '').trim(),
    transportVerified: profile.transportVerified === true,
  };
  const key = JSON.stringify([
    normalized.serverUrl,
    normalized.encryptionProtocol,
    normalized.encryptionPublicKey,
    normalized.transportVerified,
    device?.deviceId ?? '',
  ]);
  const cached = transportCache.get(key);
  if (cached) return cached;
  for (const existing of transportCache.keys()) {
    if ((JSON.parse(existing) as string[])[0] === normalized.serverUrl) transportCache.delete(existing);
  }
  if (transportCache.size >= TRANSPORT_CACHE_LIMIT) {
    const oldest = transportCache.keys().next().value;
    if (oldest !== undefined) transportCache.delete(oldest);
  }
  const transport = createSecureTransport({
    profile: normalized,
    signer: device ? deviceRequestSigner(device) : null,
  });
  transportCache.set(key, transport);
  return transport;
}
