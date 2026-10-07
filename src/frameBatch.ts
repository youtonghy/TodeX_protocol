/** Coalesces realtime conversation events into one projection per frame. */

/** Runs `task` once, later; the returned function cancels it. */
export type FrameScheduler = (task: () => void) => () => void;

/** Frame interval used where `requestAnimationFrame` does not exist. */
export const FRAME_FALLBACK_MS = 16;
/** Hidden pages and minimized windows pause `requestAnimationFrame`; a timer
 * still flushes their events (completion notices, unread state) in time. */
export const FRAME_BACKSTOP_MS = 100;

type AnimationFrameHost = {
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

/** Next animation frame, or a 16 ms timer without one. When animation frames
 * are available a 100 ms timer backs them up; whichever fires first wins. */
export const scheduleAnimationFrame: FrameScheduler = (task) => {
  const host = globalThis as AnimationFrameHost;
  let done = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    done = true;
    if (frame !== null) host.cancelAnimationFrame?.(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const fire = () => {
    if (done) return;
    cancel();
    task();
  };
  if (typeof host.requestAnimationFrame === 'function') {
    frame = host.requestAnimationFrame(fire);
    timer = setTimeout(fire, FRAME_BACKSTOP_MS);
  } else {
    timer = setTimeout(fire, FRAME_FALLBACK_MS);
  }
  return cancel;
};

type PendingBatch<E> = { workspaceId: string; events: E[] };

/**
 * Buffers realtime events per conversation and hands each conversation's
 * events to `deliver` in arrival order, once per scheduled frame. A burst of
 * deltas then costs one projection and one render instead of one per event.
 *
 * - `flush()` delivers synchronously; call it before handling any message
 *   that must observe the events received before it.
 * - `discard()` drops what is buffered (backend switch, unmount).
 * - A throwing `deliver` does not stop the other conversations; the error
 *   goes to `onError` (the projection's gap recovery refetches what the
 *   failed batch carried).
 */
export class ConversationEventBatcher<E> {
  private pending = new Map<string, PendingBatch<E>>();
  private cancelScheduled: (() => void) | null = null;

  constructor(
    private readonly deliver: (conversationId: string, workspaceId: string, events: E[]) => void,
    private readonly onError: (error: unknown) => void,
    private readonly schedule: FrameScheduler = scheduleAnimationFrame,
  ) {}

  /** Events buffered across all conversations. */
  get size(): number {
    let count = 0;
    for (const batch of this.pending.values()) count += batch.events.length;
    return count;
  }

  push(conversationId: string, workspaceId: string, event: E): void {
    const batch = this.pending.get(conversationId);
    if (batch) {
      batch.workspaceId = workspaceId;
      batch.events.push(event);
    } else {
      this.pending.set(conversationId, { workspaceId, events: [event] });
    }
    this.cancelScheduled ??= this.schedule(() => {
      this.cancelScheduled = null;
      this.flush();
    });
  }

  flush(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    // Swap first: a delivery that pushes again (or flushes re-entrantly)
    // starts a fresh batch instead of mutating the one being drained.
    const batches = this.pending;
    if (!batches.size) return;
    this.pending = new Map();
    for (const [conversationId, batch] of batches) {
      try {
        this.deliver(conversationId, batch.workspaceId, batch.events);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  discard(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.pending.clear();
  }
}
