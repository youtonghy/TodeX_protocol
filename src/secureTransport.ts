import { ConnectionError, ConnectionErrorType } from './connectionError';
import { deviceAuthHeaders, deviceAuthQuery, type DeviceIdentity } from './deviceAuth';
import { isLoopbackUrl } from './mobileParity';
import {
  TRANSPORT_V2_SEALED_CONTENT_TYPE,
  TRANSPORT_V2_SEALED_PATH,
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
// - a pinned protocol + key  -> v2 everywhere (REST through POST /v2/sealed,
//   WebSocket with tv=2), loopback included;
// - no pinned key, remote    -> refuse (`EncryptionRequiredError`), never a
//   plaintext fallback;
// - no pinned key, loopback  -> plaintext.
// Callers see plain requests, responses and JSON text messages.

export type SecureTransportProfile = {
  serverUrl: string;
  encryptionProtocol: TransportEncryptionProtocol;
  /** Pinned server static public key (base64url); empty when unpaired. */
  encryptionPublicKey: string;
};

export type SecureTransportMode = 'v2' | 'plaintext' | 'refused';

/** What the device-auth signer covers: always the *inner* request. */
export type SignableRequest = { method: string; path: string; query: string; body: Uint8Array };

export type DeviceRequestSigner = {
  /** Device id the credentials carry; bound into the WebSocket key schedule. */
  deviceId: string;
  /** Device-auth headers for a REST request. */
  signRequest: (request: SignableRequest) => Record<string, string>;
  /** Device-auth query parameters for the WebSocket upgrade (`GET`, empty body). */
  signUpgrade: (request: { path: string; query: string }) => Record<string, string>;
};

/** Signer backed by `deviceAuth.ts` (`todex.device-auth.v1`). */
export function deviceRequestSigner(device: DeviceIdentity): DeviceRequestSigner {
  return {
    deviceId: device.deviceId,
    signRequest: ({ method, path, query, body }) =>
      deviceAuthHeaders(device, method, query ? `${path}?${query}` : path, body),
    signUpgrade: ({ path, query }) => deviceAuthQuery(device, 'GET', path, query),
  };
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
      '远程后端必须使用加密连接，请重新扫码进行加密配对',
      `no pinned transport key for non-loopback host ${serverUrl}`,
      false,
      'encryption_required',
    );
    this.name = 'EncryptionRequiredError';
  }
}

/** The server now requires a different protocol than the one pinned at pairing. */
export class TransportRepairRequiredError extends ConnectionError {
  constructor(readonly pinned: string, readonly required: string) {
    super(
      ConnectionErrorType.ENCRYPTION_REQUIRED,
      '后端的加密方式已变更，请重新配对',
      `pinned ${pinned}, server requires ${required}`,
      false,
      'encryption_required',
    );
    this.name = 'TransportRepairRequiredError';
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

/** `ws(s)://` server URLs are accepted for the HTTP origin they name. */
function httpServerUrl(serverUrl: string): string {
  return (serverUrl ?? '').trim().replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
}

export function secureTransportMode(profile: SecureTransportProfile): SecureTransportMode {
  if (pinnedProtocol(profile)) return 'v2';
  return isLoopbackUrl(httpServerUrl(profile.serverUrl)) ? 'plaintext' : 'refused';
}

/**
 * Checks a `/v2/transport-policy` answer against the profile. The answer
 * never downgrades a pinned profile to plaintext: a pinned profile whose
 * server now requires another protocol (including `none`, which has no
 * static key to run v2 against) must be re-paired.
 */
export function checkTransportPolicy(
  profile: SecureTransportProfile,
  policy: { requiredProtocol?: unknown; transportVersion?: unknown },
): void {
  const mode = secureTransportMode(profile);
  if (mode === 'refused') throw new EncryptionRequiredError(profile.serverUrl);
  const pinned = pinnedProtocol(profile);
  if (!pinned) return;
  const required = policy.requiredProtocol === 'none' ? 'none' : parseSecureTransportProtocol(policy.requiredProtocol);
  if (required && required !== pinned) {
    throw new TransportRepairRequiredError(pinned, required);
  }
  if (policy.transportVersion !== TRANSPORT_V2_VERSION) {
    throw new TransportPolicyError('outdated', false);
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
 * Runs the connect-time policy check: refuses an unpaired remote profile
 * without touching the network, then reads `/v2/transport-policy` (direct
 * and unsigned: it is on the plaintext allow-list and carries no secrets)
 * and applies `checkTransportPolicy`. Rejects with `EncryptionRequiredError`,
 * `InvalidPinnedKeyError`, `TransportRepairRequiredError`,
 * `TransportPolicyError`, or an `AbortError`
 * when `signal` aborts.
 */
export async function verifyTransportPolicy(
  profile: SecureTransportProfile,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (secureTransportMode(profile) === 'refused') throw new EncryptionRequiredError(profile.serverUrl);
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
  checkTransportPolicy(profile, policy as { requiredProtocol?: unknown; transportVersion?: unknown });
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
    if (mode === 'refused') throw new EncryptionRequiredError(profile.serverUrl);
  };

  const prepare = (request: SecureRequest) => {
    const query = queryString(request.query);
    const body = bodyBytes(request.body);
    const method = request.method.toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value;
    if (signer) {
      Object.assign(headers, signer.signRequest({ method, path: request.path, query, body }));
    }
    return { method, path: request.path, query, body, headers };
  };

  const send = async (request: SecureRequest, streaming: boolean): Promise<SecureResponse | SecureStreamResponse> => {
    requireAllowed();
    const inner = prepare(request);
    // Before anything leaves: the backend answers an oversized body with an
    // opaque 400 that reads like a pairing failure.
    assertPlaintextFits(inner.body.length, maxBodyBytes);
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
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || contentType !== TRANSPORT_V2_SEALED_CONTENT_TYPE) {
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
      const signed = signer.signUpgrade({ path, query: params.toString() });
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
 * One `SecureTransport` per backend profile (server URL, pinned protocol and
 * key, device). A changed profile yields a new instance; the previous one for
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
  };
  const key = JSON.stringify([
    normalized.serverUrl,
    normalized.encryptionProtocol,
    normalized.encryptionPublicKey,
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
