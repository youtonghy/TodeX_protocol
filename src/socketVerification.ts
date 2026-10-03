import type { TransportCryptoSession } from './transportCrypto';

/** The part of a WebSocket (browser or Node) the verifier uses. */
export interface VerifiableSocket {
  send(data: string): void;
  // `any`: browser and Node WebSocket listener signatures differ.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

/** `retryable`: the socket dropped mid-handshake. Otherwise the reply was
 * wrong or undecryptable, i.e. the imported server key does not match. */
export class SocketVerificationError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean) {
    super(retryable ? 'encrypted socket dropped during verification' : 'encrypted socket verification failed');
    this.name = 'SocketVerificationError';
    this.retryable = retryable;
  }
}

/**
 * Consume an encrypted `server.ping` reply before the normal message
 * dispatcher starts. This verifies actual possession of the imported server
 * key, rather than treating the WebSocket upgrade as a successful encrypted
 * session. Rejects with an `AbortError` when `signal` aborts.
 */
export function verifyEncryptedSocket(
  socket: VerifiableSocket,
  session: TransportCryptoSession,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const { signal, timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    const id = `transport-verification-${globalThis.crypto.randomUUID()}`;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onTransportFailure);
      socket.removeEventListener('error', onTransportFailure);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onTransportFailure = () => finish(new SocketVerificationError(true));
    const onProtocolFailure = () => finish(new SocketVerificationError(false));
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
    const onMessage = (event: { data: unknown }) => {
      try {
        const value = JSON.parse(session.decryptServerText(String(event.data))) as Record<string, unknown>;
        if (value.id !== id) return;
        const payload = value.payload as { pong?: unknown } | undefined;
        if (value.type !== 'server.result' || payload?.pong !== true) { onProtocolFailure(); return; }
        finish();
      } catch { onProtocolFailure(); }
    };
    const timer = setTimeout(onTransportFailure, timeoutMs);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onTransportFailure);
    socket.addEventListener('error', onTransportFailure);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      socket.send(session.encryptClientText(JSON.stringify({ id, type: 'server.ping', payload: {} })));
    } catch { onTransportFailure(); }
  });
}
