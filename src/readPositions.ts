/**
 * Shared read positions (TodeX_backend docs/API.md "已读位置"). A backend
 * with `readSync` keeps one `readSequence` per conversation for all of the
 * owner's devices, moved by `conversation.read` and announced by the
 * `conversation.read` event, so a reply read on one device stops waiting
 * on the others.
 */

export const CONVERSATION_READ_EVENT = 'conversation.read';

export type ConversationReadPosition = { conversationId: string; readSequence: number };

const isSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `conversation.read`: the device has seen the conversation up to
 * `sequence` (its newest event when omitted). */
export function conversationReadFrame(conversationId: string, sequence?: number): { type: string; payload: Record<string, unknown> } {
  if (!conversationId.trim()) throw new Error('conversation.read needs a conversation id');
  if (sequence !== undefined && !isSequence(sequence)) throw new Error('conversation.read needs a non-negative sequence');
  return { type: CONVERSATION_READ_EVENT, payload: sequence === undefined ? { conversationId } : { conversationId, sequence } };
}

/** The `conversation.read` event's payload, or the command's result. */
export function parseConversationReadPosition(payload: unknown): ConversationReadPosition | null {
  if (!payload || typeof payload !== 'object') return null;
  const { conversationId, readSequence } = payload as Record<string, unknown>;
  if (typeof conversationId !== 'string' || !conversationId || !isSequence(readSequence)) return null;
  return { conversationId, readSequence };
}

/** A manifest's `readSequence`, or undefined when absent or malformed. */
export function readSequenceOf(value: unknown): number | undefined {
  return isSequence(value) ? value : undefined;
}

/**
 * Whether a conversation holds events no device has seen. A conversation
 * without a read position predates read sync and counts as read, so an
 * upgraded backend does not flag its whole history.
 */
export function hasUnseenEvents(lastSequence: number | undefined, readSequence: number | undefined): boolean {
  return readSequence !== undefined && lastSequence !== undefined && lastSequence > readSequence;
}

export type ReadReporterOptions = {
  /** Sends `conversation.read`; a rejection is reported to `onError`, and the
   * position is sent again with the next mark. */
  send: (conversationId: string, sequence: number) => Promise<unknown>;
  /** Longest a newer position waits after the previous send. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
};

/**
 * Reports one backend's read positions without flooding it: an open
 * conversation marks itself read with every event, so each conversation
 * sends at most once per `intervalMs` (the newest position always goes out,
 * trailing), and never a position the backend already holds (`known`, fed
 * from manifests and `conversation.read` events).
 */
export class ReadReporter {
  private readonly known = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private readonly sentAt = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();
  private readonly intervalMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: ReadReporterOptions) {
    this.intervalMs = options.intervalMs ?? 1500;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
  }

  /** The backend holds `sequence` (or later) for this conversation. */
  learn(conversationId: string, sequence: number | undefined): void {
    if (sequence === undefined) return;
    if ((this.known.get(conversationId) ?? -1) < sequence) this.known.set(conversationId, sequence);
    const pending = this.pending.get(conversationId);
    if (pending !== undefined && pending <= sequence) this.cancel(conversationId);
  }

  /** This device has seen the conversation up to `sequence`. */
  mark(conversationId: string, sequence: number): void {
    if (!isSequence(sequence)) return;
    if ((this.known.get(conversationId) ?? -1) >= sequence) return;
    if ((this.pending.get(conversationId) ?? -1) >= sequence) return;
    this.pending.set(conversationId, sequence);
    if (this.timers.has(conversationId)) return;
    const wait = (this.sentAt.get(conversationId) ?? -Infinity) + this.intervalMs - this.now();
    if (wait <= 0) this.flush(conversationId);
    else this.timers.set(conversationId, this.setTimer(() => this.flush(conversationId), wait));
  }

  /** Drops every pending send (the link closed or the backend went away). */
  dispose(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
    this.pending.clear();
  }

  private cancel(conversationId: string): void {
    const timer = this.timers.get(conversationId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(conversationId);
    this.pending.delete(conversationId);
  }

  private flush(conversationId: string): void {
    this.timers.delete(conversationId);
    const sequence = this.pending.get(conversationId);
    this.pending.delete(conversationId);
    if (sequence === undefined || (this.known.get(conversationId) ?? -1) >= sequence) return;
    this.sentAt.set(conversationId, this.now());
    this.options.send(conversationId, sequence).then(
      (result) => {
        const position = parseConversationReadPosition(result);
        this.learn(conversationId, position?.readSequence ?? sequence);
      },
      (error: unknown) => this.options.onError?.(error),
    );
  }
}
