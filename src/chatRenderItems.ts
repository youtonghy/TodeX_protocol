import { isStepProgressEntry, type TimelineEntry } from './mobileParity';

// The chat's row layout, shared by every client: which steps fold into a
// trace, where narration splits it, and which trace is still live. Moved from
// TodeX_desktop's `components/conversationTimeline.ts` (mirrored by
// TodeX_web), which still hold their own copies.

// Rows are immutable (an update replaces the object), so their grouping keys
// are computed once per row instead of once per rebuild.
const turnKeyCache = new WeakMap<TimelineEntry, string>();
const userKeyCache = new WeakMap<TimelineEntry, string>();

function chatTurnKey(entry: TimelineEntry): string {
  let key = turnKeyCache.get(entry);
  if (key === undefined) {
    key = JSON.stringify([entry.conversationId ?? '', 'turn', entry.turnId]);
    turnKeyCache.set(entry, key);
  }
  return key;
}

function chatUserKey(entry: TimelineEntry): string {
  if (entry.turnId) return chatTurnKey(entry);
  let key = userKeyCache.get(entry);
  if (key === undefined) {
    key = JSON.stringify([entry.conversationId ?? '', 'user', entry.id]);
    userKeyCache.set(entry, key);
  }
  return key;
}

export type ChatExecutionGroup = { type: 'executionGroup'; id: string; entries: TimelineEntry[]; turnId?: string; userMessageId?: string };
export type ChatRenderItem = { type: 'entry'; entry: TimelineEntry } | ChatExecutionGroup;

/** Steps that fold into the collapsed trace. `assistant_progress` narration is
 * deliberately excluded: progress text reads like a message and stays visible
 * as a standalone line, while still splitting adjacent tool runs. A summary
 * replay's progress stub has no text yet (often an empty provider envelope,
 * e.g. Pi's per-message start), so it folds with the steps around it and
 * hydrates with them; only real narration splits the trace once loaded. */
export function isFoldedStepEntry(entry: TimelineEntry): boolean {
  return isStepProgressEntry(entry) && (entry.category !== 'assistant_progress' || entry.detailStub === true);
}

/** Consecutive steps fold into one trace; text between two runs starts a new
 * trace so the working notes stay interleaved with the narration they belong
 * to. Unattributed startup statuses are not conversation content. `entries`
 * are in display order (oldest first). */
export function buildChatRenderItems(entries: readonly TimelineEntry[]): ChatRenderItem[] {
  const anchors = new Map<string, TimelineEntry>();
  for (const entry of entries) {
    if (entry.kind === 'outgoing' && !anchors.has(chatUserKey(entry))) anchors.set(chatUserKey(entry), entry);
  }
  const groups = new Map<string, { group: ChatExecutionGroup; anchor: string }>();
  const entryGroup = new Map<TimelineEntry, string>();
  const runCounts = new Map<string, number>();
  let currentUser: TimelineEntry | undefined;
  let orphanKey = '';
  let open: { key: string; id: string; group: ChatExecutionGroup } | undefined;
  for (const entry of entries) {
    if (entry.kind === 'outgoing') { currentUser = entry; orphanKey = ''; open = undefined; }
    if (!isFoldedStepEntry(entry)) { open = undefined; continue; }
    if (!entry.turnId && !currentUser && entry.category === 'status') continue;
    const key = entry.turnId ? chatTurnKey(entry) : currentUser ? chatUserKey(currentUser)
      : (orphanKey ||= JSON.stringify([entry.conversationId ?? '', 'orphan', entry.id]));
    if (open?.key !== key) {
      const run = (runCounts.get(key) ?? 0) + 1;
      runCounts.set(key, run);
      const groupId = `${key}#${run}`;
      const group: ChatExecutionGroup = {
        type: 'executionGroup', id: `chat-process-${groupId}`, entries: [],
        turnId: entry.turnId || anchors.get(key)?.turnId || undefined, userMessageId: anchors.get(key)?.id,
      };
      groups.set(groupId, { group, anchor: key });
      open = { key, id: groupId, group };
    }
    entryGroup.set(entry, open.id);
    open.group.entries.push(entry);
  }
  const items: ChatRenderItem[] = [];
  const emitted = new Set<string>();
  const emittedAnchors = new Set<string>();
  const pendingByAnchor = new Map<string, string[]>();
  let lastGroupAnchor = '';
  const emit = (groupId: string) => {
    const found = groups.get(groupId);
    if (!found || emitted.has(groupId)) return;
    // Runs that end up adjacent with no text between them fold back into a
    // single trace; only runs separated by messages stay interleaved.
    const last = items[items.length - 1];
    if (last?.type === 'executionGroup' && lastGroupAnchor === found.anchor) {
      last.entries.push(...found.group.entries);
    } else {
      items.push(found.group);
      lastGroupAnchor = found.anchor;
    }
    emitted.add(groupId);
  };
  for (const entry of entries) {
    const groupId = entryGroup.get(entry);
    if (groupId) {
      const found = groups.get(groupId);
      if (found && found.group.entries[0] === entry) {
        // A trace whose steps precede its prompt in replay order still emits
        // with that prompt; later runs sit between the texts they separate.
        if (anchors.has(found.anchor) && !emittedAnchors.has(found.anchor)) {
          const pending = pendingByAnchor.get(found.anchor) ?? [];
          pending.push(groupId);
          pendingByAnchor.set(found.anchor, pending);
        } else {
          emit(groupId);
        }
      }
      continue;
    }
    if (isFoldedStepEntry(entry)) continue;
    items.push({ type: 'entry', entry });
    lastGroupAnchor = '';
    if (entry.kind === 'outgoing') {
      const anchor = chatUserKey(entry);
      emittedAnchors.add(anchor);
      for (const pending of pendingByAnchor.get(anchor) ?? []) emit(pending);
      pendingByAnchor.delete(anchor);
    }
  }
  return items;
}

/** The execution group that is still live for the running turn. A group the
 * agent has already replied after is finished — its tools may still run in
 * the background, but the live status belongs below the newest reply. */
export function activeChatProcessId(items: readonly ChatRenderItem[], activeTurnId?: string): string {
  // Runs on every render: scan from the end without copying the rows.
  let user: TimelineEntry | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === 'entry' && item.entry.kind === 'outgoing') { user = item.entry; break; }
  }
  let groupIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === 'executionGroup' && (
      activeTurnId ? item.turnId === activeTurnId : !item.turnId && Boolean(user) && item.userMessageId === user?.id
    )) { groupIndex = index; break; }
  }
  const group = items[groupIndex];
  if (group?.type !== 'executionGroup') return '';
  if (user && group.userMessageId !== user.id && user.turnId !== group.turnId) return '';
  for (let index = groupIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.type === 'entry' && item.entry.kind === 'incoming') return '';
  }
  return group.id;
}
