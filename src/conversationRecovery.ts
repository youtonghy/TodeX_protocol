import { applyConversationRuntimeEvents, createConversationRuntime, type ConversationRuntime } from './conversationRuntime';
import type { ConversationEvent, ConversationReplay } from './v2';

type Replay = (conversationId: string, afterSequence: number, limit: number) => Promise<ConversationReplay>;
type Update = (state: ConversationRuntime, applied: ConversationEvent[], recovering: boolean) => void;

/** History pages arrive in bursts; merging their notifications into one
 * update per interval keeps rendering and list ordering stable. */
const NOTIFY_INTERVAL_MS = 60;

/** One projection is shared by REST pages and live frames. A late history
 * response can fill a gap, but can never replace newer applied state. */
export class ConversationRecovery {
  private readonly states = new Map<string, ConversationRuntime>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly incomplete = new Set<string>();
  private readonly pendingNotify = new Map<string, { applied: ConversationEvent[]; recovering: boolean }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;

  constructor(private readonly replay: Replay, private readonly update: Update, private readonly onError: (message: string) => void) {}

  get(conversationId: string): ConversationRuntime | undefined { return this.states.get(conversationId); }
  isRecovering(conversationId: string): boolean { return this.recovering.has(conversationId) || this.incomplete.has(conversationId); }

  reset(): void {
    this.epoch++;
    this.states.clear();
    this.incomplete.clear();
    this.recovering.clear();
    this.pendingNotify.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private queueUpdate(conversationId: string, applied: ConversationEvent[], recovering: boolean): void {
    const pending = this.pendingNotify.get(conversationId);
    if (pending) {
      pending.applied.push(...applied);
      pending.recovering ||= recovering;
    } else {
      this.pendingNotify.set(conversationId, { applied: [...applied], recovering });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushUpdates(), NOTIFY_INTERVAL_MS);
    }
  }

  /** Delivered updates during recovery are isolated: a consumer failure is
   * reported through onError instead of aborting the replay loop. */
  private deliver(conversationId: string, applied: ConversationEvent[], recovering: boolean): void {
    const state = this.states.get(conversationId);
    if (!state) return;
    try {
      this.update(state, applied, this.isRecovering(conversationId) || recovering);
    } catch (error) {
      this.onError(error instanceof Error ? error.message : '对话状态提交失败');
    }
  }

  private flushConversation(conversationId: string): void {
    const pending = this.pendingNotify.get(conversationId);
    if (!pending) return;
    this.pendingNotify.delete(conversationId);
    this.deliver(conversationId, pending.applied, pending.recovering);
  }

  private flushUpdates(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingNotify.size) return;
    const pending = [...this.pendingNotify.keys()];
    for (const conversationId of pending) {
      this.flushConversation(conversationId);
    }
  }

  receive(conversationId: string, workspaceId: string, events: readonly ConversationEvent[]): void {
    const committed = this.states.get(conversationId);
    const previous = committed ?? createConversationRuntime(conversationId, workspaceId);
    const result = applyConversationRuntimeEvents(previous, events);
    if (result.state === previous && committed) return;
    const recovering = this.isRecovering(conversationId) || result.missingSequences.length > 0;
    // The state commits before the consumer runs so callbacks observing
    // get() see the latest projection.
    this.states.set(conversationId, result.state);
    if (this.recovering.has(conversationId)) {
      // Inside a recovery pass the consumer is only notified once per
      // interval (and once at the end).
      this.queueUpdate(conversationId, result.appliedEvents, recovering);
    } else {
      // Live frames keep the synchronous contract: a throwing consumer
      // rolls the commit back.
      try {
        this.update(result.state, result.appliedEvents, recovering);
      } catch (error) {
        if (this.states.get(conversationId) === result.state) {
          if (committed) this.states.set(conversationId, committed);
          else this.states.delete(conversationId);
        }
        throw error;
      }
    }
    if (result.missingSequences.length && !this.recovering.has(conversationId)) {
      void this.recover(conversationId, workspaceId);
    }
  }

  recover(conversationId: string, workspaceId: string): Promise<void> {
    const existing = this.recovering.get(conversationId);
    if (existing) return existing;
    const epoch = this.epoch;
    // Defer work until the single-flight entry exists, including synchronous
    // replay mocks. This also suppresses stale approval prompts during replay.
    const work = Promise.resolve().then(async () => {
      let cursor = this.states.get(conversationId)?.appliedSequence ?? 0;
      let pages = 0;
      for (;;) {
        const page = await this.replay(conversationId, cursor, 500);
        if (epoch !== this.epoch) return;
        this.receive(conversationId, workspaceId, page.events);
        const state = this.states.get(conversationId)!;
        const next = state.appliedSequence;
        const missing = next < state.highWaterSequence;
        if (!page.hasMore && !missing) {
          this.incomplete.delete(conversationId);
          return;
        }
        if (next <= cursor || ++pages >= 10_000) {
          throw new Error('对话记录存在缺口，恢复未完成。请重新连接后核对记录。');
        }
        cursor = next;
      }
    }).catch((error: unknown) => {
      if (epoch === this.epoch) {
        this.incomplete.add(conversationId);
        this.onError(error instanceof Error ? error.message : '对话恢复失败');
      }
    }).finally(() => {
      if (epoch !== this.epoch) return;
      this.recovering.delete(conversationId);
      this.flushConversation(conversationId);
      const state = this.states.get(conversationId);
      if (state) this.update(state, [], this.isRecovering(conversationId));
    });
    this.recovering.set(conversationId, work);
    const state = this.states.get(conversationId);
    if (state) this.update(state, [], true);
    return work;
  }
}
