import type { TimelineEntry } from './mobileParity';

export type TimelineUpdater = (entries: readonly TimelineEntry[]) => TimelineEntry[];
type Listener = () => void;

function bucketKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

function sameEntries(left: readonly TimelineEntry[], right: readonly TimelineEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export class TimelineStore {
  private entries: TimelineEntry[] = [];
  private buckets = new Map<string, TimelineEntry[]>();
  private listeners = new Set<Listener>();
  private bucketListeners = new Map<string, Set<Listener>>();

  constructor(private readonly limit: number) {}

  getAllSnapshot = (): TimelineEntry[] => this.entries;

  getConversationSnapshot = (workspaceId: string, conversationId: string): TimelineEntry[] => (
    this.buckets.get(bucketKey(workspaceId, conversationId)) ?? EMPTY_TIMELINE
  );

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeConversation = (workspaceId: string, conversationId: string, listener: Listener): (() => void) => {
    const key = bucketKey(workspaceId, conversationId);
    const listeners = this.bucketListeners.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    this.bucketListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.bucketListeners.delete(key);
      }
    };
  };

  replace(entries: readonly TimelineEntry[]): void {
    this.commit(entries.slice(0, this.limit));
  }

  update(updater: TimelineUpdater): void {
    this.commit(updater(this.entries).slice(0, this.limit));
  }

  append(entry: TimelineEntry): void {
    this.commit([entry, ...this.entries].slice(0, this.limit));
  }

  upsertBatch(updates: readonly { entry: TimelineEntry; appendSubtitle: boolean }[]): void {
    if (updates.length === 0) return;
    let next = this.entries;
    for (const update of updates) {
      const index = next.findIndex((item) => (
        item.id === update.entry.id
        && item.workspaceId === update.entry.workspaceId
        && item.conversationId === update.entry.conversationId
      ));
      if (index === -1) {
        next = [update.entry, ...next].slice(0, this.limit);
        continue;
      }
      const previous = next[index];
      const merged = {
        ...previous,
        ...update.entry,
        subtitle: update.appendSubtitle
          ? `${previous.subtitle === '正在回复...' ? '' : previous.subtitle}${update.entry.subtitle}`
          : update.entry.subtitle,
      };
      if (
        merged.kind === previous.kind
        && merged.title === previous.title
        && merged.subtitle === previous.subtitle
        && merged.at === previous.at
        && merged.category === previous.category
        && merged.phase === previous.phase
        && merged.turnId === previous.turnId
        && merged.blockId === previous.blockId
        && merged.contentIndex === previous.contentIndex
        && merged.sequence === previous.sequence
        && merged.requestId === previous.requestId
      ) {
        continue;
      }
      if (next === this.entries) next = this.entries.slice();
      const mutable = next as TimelineEntry[];
      mutable[index] = merged;
    }
    if (next !== this.entries) this.commit(next);
  }

  private commit(next: TimelineEntry[]): void {
    if (sameEntries(this.entries, next)) return;

    const previousBuckets = this.buckets;
    const grouped = new Map<string, TimelineEntry[]>();
    for (const entry of next) {
      if (!entry.conversationId) continue;
      const key = bucketKey(entry.workspaceId ?? '', entry.conversationId);
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry);
      grouped.set(key, bucket);
    }

    const nextBuckets = new Map<string, TimelineEntry[]>();
    const changedKeys = new Set<string>();
    const keys = new Set([...previousBuckets.keys(), ...grouped.keys()]);
    for (const key of keys) {
      const previous = previousBuckets.get(key) ?? EMPTY_TIMELINE;
      const candidate = grouped.get(key) ?? EMPTY_TIMELINE;
      if (sameEntries(previous, candidate)) {
        if (previous.length > 0) nextBuckets.set(key, previous);
      } else {
        if (candidate.length > 0) nextBuckets.set(key, candidate);
        changedKeys.add(key);
      }
    }

    this.entries = next;
    this.buckets = nextBuckets;
    this.listeners.forEach((listener) => listener());
    changedKeys.forEach((key) => this.bucketListeners.get(key)?.forEach((listener) => listener()));
  }
}

export class ConversationReplayTracker {
  private subscriptions = new Set<string>();

  subscriptionCursor(conversationId: string): number | null {
    if (!conversationId || this.subscriptions.has(conversationId)) return null;
    return 0;
  }

  markSubscribed(conversationId: string): void {
    if (conversationId) this.subscriptions.add(conversationId);
  }

  resetConnection(): void {
    this.subscriptions.clear();
  }
}

const EMPTY_TIMELINE: TimelineEntry[] = Object.freeze([]) as unknown as TimelineEntry[];
