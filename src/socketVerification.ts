/** `retryable`: the socket dropped mid-handshake. Otherwise the reply was
 * wrong, i.e. the server answered but not as a TodeX backend would. */
export class SocketVerificationError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean) {
    super(retryable ? 'encrypted socket dropped during verification' : 'encrypted socket verification failed');
    this.name = 'SocketVerificationError';
    this.retryable = retryable;
  }
}

export type SocketVerification = {
  /** Settles once the pong arrived, the socket failed, the timeout fired or `signal` aborted. */
  readonly done: Promise<void>;
  readonly settled: boolean;
  /**
   * Feed every opened (plaintext) message received before `done` settles.
   * Messages other than the pong are ignored; the caller drops them.
   */
  handleMessage: (text: string) => void;
  /** The socket closed or errored before the pong. */
  fail: () => void;
};

/**
 * Round-trips a `server.ping` right after a transport v2 socket opened,
 * before the normal message dispatcher starts. The ping is the first sealed
 * frame, so the pong proves the server opened it with the pinned key (a
 * wrong key closes the socket with `4400` instead). `send` is the secure
 * socket's sender; incoming messages are fed through `handleMessage`.
 * `done` rejects with `SocketVerificationError` or an `AbortError`.
 */
export function startSocketVerification(
  send: (text: string) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): SocketVerification {
  const { signal, timeoutMs = 10_000 } = options;
  const id = `transport-verification-${globalThis.crypto.randomUUID()}`;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (error) rejectDone(error); else resolveDone();
  };
  const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
  const timer = setTimeout(() => finish(new SocketVerificationError(true)), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  const verification: SocketVerification = {
    done,
    get settled() {
      return settled;
    },
    handleMessage: (text: string) => {
      if (settled) return;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(text) as Record<string, unknown>;
      } catch {
        finish(new SocketVerificationError(false));
        return;
      }
      if (value?.id !== id) return;
      const payload = value.payload as { pong?: unknown } | undefined;
      if (value.type !== 'server.result' || payload?.pong !== true) {
        finish(new SocketVerificationError(false));
        return;
      }
      finish();
    },
    fail: () => finish(new SocketVerificationError(true)),
  };

  if (signal?.aborted) {
    onAbort();
    return verification;
  }
  try {
    send(JSON.stringify({ id, type: 'server.ping', payload: {} }));
  } catch {
    finish(new SocketVerificationError(true));
  }
  return verification;
}
