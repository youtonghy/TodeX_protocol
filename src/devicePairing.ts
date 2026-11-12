import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { decodeBase64Url, encodeBase64Url, type DeviceIdentity } from './deviceAuth';
import { parseBackendDeployment, type BackendDeployment } from './pathMapping';
import {
  DEVICE_PAIRING_V3_NONCE_LENGTH,
  DevicePairingTransportError,
  deriveDevicePairingV3Material,
  devicePairingV3Commitment,
  normalizeDevicePairingName,
  parseDevicePairingTransport,
  transportFingerprint,
  verifyDevicePairingCredential,
  type DevicePairingPin,
  type DevicePairingTransport,
  type DevicePairingV3Material,
} from './secureChannel';
import { buildHttpUrl } from './todex';
import {
  meshHistoryKeySignature,
  meshJoinCodeKey,
  meshNodeIdForPublicKey,
  meshNodeJoinClientProof,
  meshNodeJoinServerProof,
  parseMeshSigningKey,
} from './mesh';

/**
 * Device pairing v3 over HTTP (`/v2/device-pairing/*`), shared by every
 * client. Errors carry a `code` instead of user-facing text: each client maps
 * it to its own wording through `DevicePairingOptions.message`.
 */

export type DevicePairingResult =
  | { status: 'pending' | 'rejected' | 'expired' }
  | { status: 'approved'; deviceId: string; pin: DevicePairingPin; mesh?: DevicePairingMeshResult };

/**
 * Joining a device group over pairing v3 (TodeX_backend docs/mesh-v1.md):
 * `deviceJoin` asks the group's devices to let this device in;
 * `nodeJoin` adds the backend to the group with its join code.
 */
export type DevicePairingMesh =
  | { kind: 'deviceJoin'; groupId: string; historyKey: Uint8Array }
  | { kind: 'nodeJoin'; groupId: string; joinCode: string };

/** What an approved group join adds; `nodeId`/`nodePublicKey` only for a
 * node join, after its `joinProof` verified. */
export type DevicePairingMeshResult = { groupId: string; nodeId?: string; nodePublicKey?: string };

export type DevicePairingRequest = {
  requestId: string;
  verificationCode: string;
  /** Fingerprint of the transport key the code authenticates (`'none'` for loopback plaintext). */
  transportFingerprint: string;
  /** When it expires on this device's clock (the server's time, corrected
   * by the skew its `Date` header shows). */
  expiresAt: number;
  /** How often the server asks to be polled. */
  pollIntervalMs: number;
  poll: (signal?: AbortSignal) => Promise<DevicePairingResult>;
  cancel: (signal?: AbortSignal) => Promise<void>;
};

export type DevicePairingErrorCode =
  | 'checksum'
  | 'conflict'
  | 'encryptionRequired'
  | 'http'
  | 'invalidRequest'
  | 'invalidResponse'
  | 'invalidStatus'
  | 'invalidTransport'
  | 'invalidUrl'
  | 'network'
  | 'noResult'
  | 'polling'
  | 'rejectedRequest'
  | 'timeout'
  | 'tooLarge'
  | 'tooMany'
  | 'transportMismatch'
  | 'unsupported';

/** Turns an error code (and the HTTP status for `http`) into the message the error carries. */
export type DevicePairingMessage = (code: DevicePairingErrorCode, params: { status?: number }) => string;

export type DevicePairingOptions = {
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Join a device group instead of pairing with this backend. */
  mesh?: DevicePairingMesh;
  /** Defaults to the code itself. */
  message?: DevicePairingMessage;
};

export class DevicePairingError extends Error {
  constructor(message: string, readonly code: DevicePairingErrorCode, readonly status?: number) {
    super(message);
    this.name = 'DevicePairingError';
  }
}

/**
 * A pairing call that failed transiently (`429`, `5xx`, network error or
 * timeout). Polling backs off and continues until the request expires; it
 * ends only on `404`, `401`/`403`, a rejected or expired request, or when the
 * user cancels.
 */
export class DevicePairingRetryableError extends DevicePairingError {
  constructor(message: string, code: DevicePairingErrorCode, readonly retryAfterMs?: number, status?: number) {
    super(message, code, status);
    this.name = 'DevicePairingRetryableError';
  }
}

const MAX_RESPONSE_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 10_000;
/** Normal poll interval while a request waits for approval. */
export const PAIRING_POLL_INTERVAL_MS = 2000;
/** Longest wait between polls after transient failures. */
export const PAIRING_POLL_MAX_BACKOFF_MS = 5000;

/** Next poll delay after a transient failure: doubled, at least `Retry-After`, at most 5 s. */
export function nextPairingPollDelayMs(previousMs: number, error: DevicePairingRetryableError): number {
  return Math.min(Math.max(previousMs * 2, error.retryAfterMs ?? 0), PAIRING_POLL_MAX_BACKOFF_MS);
}

function retryAfterMs(value: string | null): number | undefined {
  const trimmed = (value ?? '').trim();
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) * 1000 : undefined;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16}$/;
/** Pairing runs over HTTP(S), or a local IPC backend's socket (`todex-ipc:`). */
const PAIRING_PROTOCOLS = ['http:', 'https:', 'todex-ipc:'];

type Errors = {
  fail: (code: DevicePairingErrorCode, status?: number) => DevicePairingError;
  retry: (code: DevicePairingErrorCode, retryAfter?: number, status?: number) => DevicePairingRetryableError;
};

function errors(message: DevicePairingMessage = (code) => code): Errors {
  return {
    fail: (code, status) => new DevicePairingError(message(code, { status }), code, status),
    retry: (code, retryAfter, status) => new DevicePairingRetryableError(message(code, { status }), code, retryAfter, status),
  };
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** Strict base64url: only the URL-safe alphabet, unpadded, canonical, and of the expected length. */
function decode(value: unknown, err: Errors, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_RESPONSE_BYTES) {
    throw err.fail('invalidResponse');
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch {
    throw err.fail('invalidResponse');
  }
  if ((length !== undefined && bytes.length !== length) || encodeBase64Url(bytes) !== value) {
    throw err.fail('invalidResponse');
  }
  return bytes;
}

/** The create response's transport key, validated before anything is derived from it. */
function pairingTransport(response: Record<string, unknown>, serverUrl: string, err: Errors): DevicePairingTransport {
  try {
    return parseDevicePairingTransport(response, serverUrl);
  } catch (error) {
    if (error instanceof DevicePairingTransportError && error.reason === 'encryption_required') {
      throw err.fail('encryptionRequired');
    }
    throw err.fail('invalidTransport');
  }
}

function object(value: unknown, err: Errors): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err.fail('invalidResponse');
  return value as Record<string, unknown>;
}

/** The body, or null once it passes `limit` bytes. Streams when the
 * implementation exposes `body` (reading stops at the cap); otherwise reads
 * it whole, as React Native's fetch does. */
async function readBodyCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > limit ? null : bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function pairingUrl(serverUrl: string, path: string): URL | null {
  let url: URL;
  try {
    url = new URL(buildHttpUrl(serverUrl, path));
  } catch {
    return null;
  }
  return PAIRING_PROTOCOLS.includes(url.protocol) && !url.username && !url.password ? url : null;
}

/** An `AbortController` that follows the caller's signal and times out after `REQUEST_TIMEOUT_MS`. */
function boundedRequest(signal?: AbortSignal): { controller: AbortController; done: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  return {
    controller,
    done: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

// Pairing runs before a transport key is pinned, so its routes are called
// directly (they are on the backend's plaintext allow-list), never through
// the `/v2/sealed` tunnel.
async function post(
  serverUrl: string,
  action: string,
  body: unknown,
  context: { fetchImpl: typeof fetch; err: Errors },
  signal?: AbortSignal,
  meta?: { serverTime?: number },
): Promise<Record<string, unknown>> {
  const { fetchImpl, err } = context;
  const url = pairingUrl(serverUrl, `/v2/device-pairing/${action}`);
  if (!url) throw err.fail('invalidUrl');
  const { controller, done } = boundedRequest(signal);
  // A failed connection or body read is transient; the caller's abort is not.
  const networkFailure = (error: unknown): unknown => (signal?.aborted || controller.signal.aborted
    ? error
    : err.retry('network'));
  try {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw networkFailure(error);
    }
    const serverTime = Date.parse(response.headers.get('date') ?? '');
    if (meta && Number.isFinite(serverTime)) meta.serverTime = serverTime;
    if (!response.ok) {
      const { status } = response;
      if (status === 404) throw err.fail('unsupported', status);
      // A repeated reveal or a request decided meanwhile.
      if (status === 409) throw err.fail('conflict', status);
      if (status === 429) throw err.retry('tooMany', retryAfterMs(response.headers.get('Retry-After')), status);
      if (status === 401 || status === 403) throw err.fail('rejectedRequest', status);
      if (status >= 500) throw err.retry('http', undefined, status);
      throw err.fail('http', status);
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw networkFailure(error);
    }
    if (bytes === null) throw err.fail('tooLarge');
    if (!bytes.length) throw err.fail('noResult');
    if (signal?.aborted) throw abortError();
    try {
      return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), err);
    } catch {
      throw err.fail('invalidResponse');
    }
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw err.retry('timeout');
    throw error;
  } finally {
    done();
  }
}

/** Where the backend runs, from the unauthenticated part of `/v2/version`
 * (a bootstrap route the backend serves directly, like pairing). Used only
 * to tell the user how to approve; `host` when it cannot be read or an older
 * backend omits it. */
export async function fetchBackendDeployment(
  serverUrl: string,
  signal?: AbortSignal,
  options: Pick<DevicePairingOptions, 'fetchImpl'> = {},
): Promise<BackendDeployment> {
  const url = pairingUrl(serverUrl, '/v2/version');
  if (!url) return 'host';
  const fetchImpl = options.fetchImpl ?? fetch;
  const { controller, done } = boundedRequest(signal);
  try {
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) return 'host';
    // Refused before reading when the length is declared too large; the
    // body itself is read only up to the cap.
    const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    if (bytes === null) return 'host';
    const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parseBackendDeployment(body && typeof body === 'object' ? (body as Record<string, unknown>).deployment : undefined);
  } catch {
    // Only a hint for the approval instructions; pairing itself goes on.
    return 'host';
  } finally {
    done();
  }
}

/** Device pairing v3 (commit, then reveal): `create` sends only a commitment
 * to the ephemeral key and nonce, the server answers with its per-request
 * key and its transport key, and only then `reveal` discloses them, so a man
 * in the middle cannot grind its own key against the short code. The
 * transcript binds the transport protocol and key and the device name, so the
 * code the user compares also authenticates the key that gets pinned and the
 * name the backend shows. `deviceName` is normalized first
 * (`normalizeDevicePairingName`, `'TodeX'` when nothing is left) and sent
 * exactly as bound. The device key is
 * enrolled on approval; approval returns the matching `deviceId` and the
 * verified pin (`verifyDevicePairingCredential`), which the caller writes in
 * one profile update with `transportVerified = true`. */
export async function beginDevicePairing(
  serverUrl: string,
  deviceName: string,
  device: DeviceIdentity,
  signal?: AbortSignal,
  options: DevicePairingOptions = {},
): Promise<DevicePairingRequest> {
  const err = errors(options.message);
  const context = { fetchImpl: options.fetchImpl ?? fetch, err };
  const keys = x25519.keygen();
  const clientNonce = globalThis.crypto.getRandomValues(new Uint8Array(DEVICE_PAIRING_V3_NONCE_LENGTH));
  let material: DevicePairingV3Material | undefined;
  const wipe = () => {
    material?.wrapKey.fill(0);
    material?.pollProof.fill(0);
    material?.cancelProof.fill(0);
  };
  const devicePublicKey = decodeBase64Url(device.publicKey);
  const boundName = normalizeDevicePairingName(deviceName, 'TodeX');
  try {
    const meta: { serverTime?: number } = {};
    const sentAt = Date.now();
    const mesh = options.mesh;
    const meshRequest = !mesh ? undefined : mesh.kind === 'deviceJoin'
      ? {
        kind: 'deviceJoin', groupId: mesh.groupId, historyKey: encodeBase64Url(mesh.historyKey),
        historyKeySignature: meshHistoryKeySignature(decodeBase64Url(device.secretKey), mesh.groupId, mesh.historyKey),
      }
      : { kind: 'nodeJoin', groupId: mesh.groupId };
    const response = await post(serverUrl, 'create', {
      transportBinding: 1,
      deviceNameBinding: 1,
      clientCommitment: encodeBase64Url(devicePairingV3Commitment(keys.publicKey, clientNonce)),
      devicePublicKey: device.publicKey,
      deviceName: boundName,
      ...(meshRequest ? { mesh: meshRequest } : {}),
    }, context, signal, meta);
    const { requestId, expiresAt: serverExpiresAt } = response;
    if (typeof requestId !== 'string' || !uuidPattern.test(requestId)
      || typeof serverExpiresAt !== 'number' || !Number.isSafeInteger(serverExpiresAt)) {
      throw err.fail('invalidRequest');
    }
    // `expiresAt` is on the server's clock: a client clock running ahead
    // would otherwise expire every request on arrival.
    const skew = meta.serverTime === undefined ? 0 : meta.serverTime - sentAt;
    const expiresAt = serverExpiresAt - skew;
    if (expiresAt <= Date.now()) throw err.fail('invalidRequest');
    const pollIntervalMs = typeof response.pollIntervalMs === 'number' && Number.isFinite(response.pollIntervalMs)
      ? Math.min(Math.max(response.pollIntervalMs, 250), PAIRING_POLL_MAX_BACKOFF_MS)
      : PAIRING_POLL_INTERVAL_MS;
    const serverKey = decode(response.serverPublicKey, err, 32);
    const transport = pairingTransport(response, serverUrl, err);
    // A node join names the node; its key is trusted only once the
    // credential's joinProof shows the node knows the join code.
    let nodePublicKey: Uint8Array | undefined;
    if (mesh?.kind === 'nodeJoin') {
      try {
        nodePublicKey = parseMeshSigningKey(response.nodePublicKey);
      } catch {
        throw err.fail('invalidResponse');
      }
      if (response.nodeId !== meshNodeIdForPublicKey(nodePublicKey)) throw err.fail('invalidResponse');
    }
    try {
      material = deriveDevicePairingV3Material({
        requestId,
        clientSecretKey: keys.secretKey,
        serverPublic: serverKey,
        devicePublic: devicePublicKey,
        clientNonce,
        transportProtocol: transport.protocol,
        transportPublicKey: transport.publicKeyRaw,
        deviceName: boundName,
      });
    } catch {
      throw err.fail('invalidResponse');
    }
    // The server shows the verification code only after the reveal opened
    // the commitment.
    const codeKey = mesh?.kind === 'nodeJoin' ? meshJoinCodeKey(mesh.joinCode) : undefined;
    const revealed = await post(serverUrl, 'reveal', {
      requestId,
      clientPublicKey: encodeBase64Url(keys.publicKey),
      clientNonce: encodeBase64Url(clientNonce),
      ...(codeKey ? { joinCodeProof: meshNodeJoinClientProof(codeKey, material.transcriptHash) } : {}),
    }, context, signal);
    if (revealed.status !== 'pending') throw err.fail('invalidStatus');
    const { transcript, transcriptHash, wrapKey, pollProof, cancelProof } = material;
    let finished = false;
    let polling = false;
    const dispose = () => {
      finished = true;
      wipe();
      codeKey?.fill(0);
    };
    return {
      requestId,
      verificationCode: material.verificationCode,
      transportFingerprint: transportFingerprint(transport.protocol, transport.publicKeyRaw),
      expiresAt,
      pollIntervalMs,
      async poll(pollSignal) {
        if (finished || Date.now() >= expiresAt) { dispose(); return { status: 'expired' }; }
        if (polling) throw err.fail('polling');
        polling = true;
        try {
          const result = await post(serverUrl, 'poll', { requestId, proof: encodeBase64Url(pollProof) }, context, pollSignal);
          if (finished || Date.now() >= expiresAt) { dispose(); return { status: 'expired' }; }
          if (result.status === 'pending') return { status: 'pending' };
          if (result.status === 'rejected' || result.status === 'expired') {
            dispose();
            return { status: result.status };
          }
          if (result.status !== 'approved') throw err.fail('invalidStatus');
          try {
            const nonce = decode(result.nonce, err, 24);
            const ciphertext = decode(result.ciphertext, err);
            const plaintext = xchacha20poly1305(wrapKey, nonce, transcript).decrypt(ciphertext);
            try {
              const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), err);
              if (typeof payload.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(payload.deviceId)) {
                throw new Error('Invalid device id');
              }
              // The device id and the transport key must equal this device
              // and the create response byte for byte; otherwise pin nothing.
              const pin = verifyDevicePairingCredential(payload, { deviceId: device.deviceId, transport });
              if (!mesh) return { status: 'approved', deviceId: payload.deviceId, pin };
              if (payload.groupId !== mesh.groupId) throw new Error('Wrong group');
              if (mesh.kind === 'deviceJoin') return { status: 'approved', deviceId: payload.deviceId, pin, mesh: { groupId: mesh.groupId } };
              // The node proves it knows the join code over this transcript
              // and its key: only then are the node and transport keys trusted.
              const expected = meshNodeJoinServerProof(codeKey!, transcriptHash, nodePublicKey!);
              if (payload.joinProof !== expected || payload.nodePublicKey !== encodeBase64Url(nodePublicKey!)
                || payload.nodeId !== meshNodeIdForPublicKey(nodePublicKey!)) {
                throw new Error('Join proof does not verify');
              }
              return {
                status: 'approved', deviceId: payload.deviceId, pin,
                mesh: { groupId: mesh.groupId, nodeId: payload.nodeId as string, nodePublicKey: payload.nodePublicKey as string },
              };
            } finally {
              plaintext.fill(0);
            }
          } catch (error) {
            if (error instanceof DevicePairingTransportError) throw err.fail('transportMismatch');
            throw err.fail('checksum');
          } finally {
            dispose();
          }
        } finally {
          polling = false;
        }
      },
      async cancel(cancelSignal) {
        if (finished) return;
        const proof = encodeBase64Url(cancelProof);
        dispose();
        await post(serverUrl, 'cancel', { requestId, proof }, context, cancelSignal);
      },
    };
  } catch (error) {
    wipe();
    throw error;
  } finally {
    keys.secretKey.fill(0);
    clientNonce.fill(0);
  }
}
