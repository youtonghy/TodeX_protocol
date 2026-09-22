import { applyConversationRuntimeEvents, createConversationRuntime, prependConversationRuntimeEvents, type ConversationRuntime } from './conversationRuntime';
import { canonicalConversationEventType } from './v2';
import type { ConversationEvent, ConversationReplay } from './v2';

type Replay = (conversationId: string, afterSequence: number, limit: number) => Promise<ConversationReplay>;
type ReplayBefore = (conversationId: string, beforeSequence: number, limit: number) => Promise<ConversationReplay>;
type Update = (state: ConversationRuntime, applied: ConversationEvent[], recovering: boolean) => void;

/** History pages arrive in bursts; merging their notifications into one
 * update per interval keeps rendering and list ordering stable. */
const NOTIFY_INTERVAL_MS = 60;
/** Events fetched per history window when lazily opening a conversation or
 * paging backwards on scroll. */
const HISTORY_PAGE_LIMIT = 300;
/** A still-running turn's start can sit far below the tail; bound the scan so
 * opening stays fast instead of blocking on the whole journal. */
const TURN_START_SCAN_MAX_PAGES = 10;

export type ConversationOpenOptions = {
  /** Journal high-water mark from the conversation manifest. */
  highWater: number;
  /** The manifest still reports an active turn: page back to its start. */
  turnActive?: boolean;
  /** Events per backward page; defaults to HISTORY_PAGE_LIMIT. */
  pageLimit?: number;
};

/** One projection is shared by REST pages and live frames. A late history
 * response can fill a gap, but can never replace newer applied state. */
export class ConversationRecovery {
  private readonly states = new Map<string, ConversationRuntime>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly incomplete = new Set<string>();
  /** Lazy-loading cursor: events at or below the floor stay unfetched. A
   * conversation without an entry was fully replayed. */
  private readonly historyFloors = new Map<string, number>();
  private readonly historyLoading = new Map<string, Promise<boolean>>();
  private readonly pendingNotify = new Map<string, { applied: ConversationEvent[]; recovering: boolean }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;

  constructor(
    private readonly replay: Replay,
    private readonly update: Update,
    private readonly onError: (message: string) => void,
    private readonly replayBefore?: ReplayBefore,
  ) {}

  get(conversationId: string): ConversationRuntime | undefined { return this.states.get(conversationId); }
  isRecovering(conversationId: string): boolean { return this.recovering.has(conversationId) || this.incomplete.has(conversationId); }
  /** Older journal pages remain unfetched. */
  hasEarlierHistory(conversationId: string): boolean { return (this.historyFloors.get(conversationId) ?? 0) > 0; }
  isLoadingEarlier(conversationId: string): boolean { return this.historyLoading.has(conversationId); }

  reset(): void {
    this.epoch++;
    this.states.clear();
    this.incomplete.clear();
    this.recovering.clear();
    this.historyFloors.clear();
    this.historyLoading.clear();
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

  /** Insert a runtime whose cursor starts at `floor`: events at or below it
   * are treated as intentionally unloaded history. A state a racing live
   * frame already created keeps its buffered events so nothing is lost. */
  private seed(conversationId: string, workspaceId: string, floor: number): void {
    const floorSequence = Math.max(0, floor);
    const existing = this.states.get(conversationId);
    if (existing && existing.appliedSequence > 0) {
      this.historyFloors.set(conversationId, Math.min(floorSequence, this.historyFloors.get(conversationId) ?? floorSequence));
      return;
    }
    const seeded = createConversationRuntime(conversationId, workspaceId, floorSequence);
    if (existing) {
      for (const event of Object.values(existing.pendingEvents)) {
        if (event.sequence > floorSequence) seeded.pendingEvents[event.sequence] = event;
      }
      seeded.highWaterSequence = existing.highWaterSequence;
    }
    this.states.set(conversationId, seeded);
    this.historyFloors.set(conversationId, floorSequence);
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

  /** Lazy history open: seeds a floor near the journal tail so only the
   * newest window projects, then applies it through the normal receive path.
   * An active turn's start is paged in (bounded) so live status still
   * projects. Falls back to the full forward replay when the backend lacks
   * reverse paging or the runtime is already initialized. */
  open(conversationId: string, workspaceId: string, options: ConversationOpenOptions): Promise<void> {
    const existing = this.recovering.get(conversationId);
    if (existing) return existing;
    const epoch = this.epoch;
    const work = Promise.resolve().then(async () => {
      const committed = this.states.get(conversationId);
      const initialized = this.historyFloors.has(conversationId) || Boolean(committed && committed.appliedSequence > 0);
      if (initialized || !this.replayBefore || options.highWater <= 0) {
        await this.replayForward(conversationId, workspaceId, epoch);
        return;
      }
      // Collect backward pages first so the floor is seeded exactly once and
      // every event applies exactly once through receive.
      const pages: ConversationEvent[][] = [];
      let cursor = options.highWater;
      let hasMore = true;
      const pageLimit = options.pageLimit ?? HISTORY_PAGE_LIMIT;
      const maxPages = options.turnActive ? TURN_START_SCAN_MAX_PAGES : 1;
      for (let count = 0; count < maxPages && cursor > 0; count++) {
        const page = await this.replayBefore(conversationId, cursor, pageLimit);
        if (epoch !== this.epoch) return;
        const last = page.events[page.events.length - 1];
        if (last && last.sequence !== cursor) {
          // A backend without reverse paging answers a forward page instead;
          // abort the lazy path and replay the whole journal.
          await this.replayForward(conversationId, workspaceId, epoch);
          return;
        }
        if (!page.events.length) { hasMore = false; cursor = 0; break; }
        pages.unshift(page.events);
        hasMore = page.hasMore;
        cursor = page.events[0].sequence - 1;
        if (!hasMore) break;
        if (!options.turnActive
          || pages.some((events) => events.some((event) => canonicalConversationEventType(event) === 'turn.started'))) break;
      }
      this.seed(conversationId, workspaceId, hasMore ? cursor : 0);
      for (const events of pages) this.receive(conversationId, workspaceId, events);
      // Live events that landed while the window was fetched leave a gap
      // above the collected pages; close it with the forward cursor.
      const state = this.states.get(conversationId);
      if (state && state.appliedSequence < state.highWaterSequence) {
        await this.replayForward(conversationId, workspaceId, epoch);
      }
      this.incomplete.delete(conversationId);
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

  /** Prepend the next older history page into the projected timeline.
   * Returns whether even earlier events remain. Single-flight per
   * conversation; resolves false until `open` seeded a floor above zero. */
  loadEarlier(conversationId: string, _workspaceId: string, limit = HISTORY_PAGE_LIMIT): Promise<boolean> {
    const inflight = this.historyLoading.get(conversationId);
    if (inflight) return inflight;
    const replayBefore = this.replayBefore;
    const floor = this.historyFloors.get(conversationId) ?? 0;
    if (!replayBefore || floor <= 0 || !this.states.has(conversationId)) {
      return Promise.resolve(false);
    }
    const epoch = this.epoch;
    const work = (async () => {
      const page = await replayBefore(conversationId, floor, limit);
      if (epoch !== this.epoch) return this.hasEarlierHistory(conversationId);
      if (!page.events.length) {
        this.historyFloors.set(conversationId, 0);
        return false;
      }
      const state = this.states.get(conversationId);
      if (state) {
        const next = prependConversationRuntimeEvents(state, page.events);
        if (next !== state) {
          this.states.set(conversationId, next);
          this.deliver(conversationId, [], this.isRecovering(conversationId));
        }
      }
      const first = page.events[0].sequence;
      this.historyFloors.set(conversationId, first - 1);
      return page.hasMore && first > 1;
    })().catch((error: unknown) => {
      if (epoch === this.epoch) {
        this.onError(error instanceof Error ? error.message : '加载更早的消息失败');
      }
      return this.hasEarlierHistory(conversationId);
    }).finally(() => {
      if (epoch === this.epoch) this.historyLoading.delete(conversationId);
    });
    this.historyLoading.set(conversationId, work);
    return work;
  }

  recover(conversationId: string, workspaceId: string): Promise<void> {
    const existing = this.recovering.get(conversationId);
    if (existing) return existing;
    const epoch = this.epoch;
    // Defer work until the single-flight entry exists, including synchronous
    // replay mocks. This also suppresses stale approval prompts during replay.
    const work = Promise.resolve().then(() => this.replayForward(conversationId, workspaceId, epoch)).catch((error: unknown) => {
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

  private async replayForward(conversationId: string, workspaceId: string, epoch: number): Promise<void> {
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
  }
}
