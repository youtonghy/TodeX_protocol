import { applyConversationRuntimeEvents, createConversationRuntime, prependConversationRuntimeEvents, type ConversationRuntime } from './conversationRuntime';
import type { TimelineEntry } from './mobileParity';
import type { ConversationReplay } from './v2';

type Replay = (conversationId: string, afterSequence: number, limit: number) => Promise<ConversationReplay>;
type ReplayBefore = (conversationId: string, beforeSequence: number, limit: number) => Promise<ConversationReplay>;

/** Events per page; the backend caps replay pages at 1000. */
const EXPORT_PAGE_LIMIT = 1000;
/** Upper bound on pages so a journal that never reports the end cannot loop forever. */
const EXPORT_MAX_PAGES = 10_000;

export type ConversationTranscriptOptions = {
  title: string;
  /** Byte budget for the whole document. Older messages are dropped first
   * and the document notes how many were left out. */
  maxBytes?: number;
  /** Messages older than the entries exist but were never read (see
   * `fetchConversationTranscriptTail`); the note then gives no count. */
  olderUnread?: boolean;
};

/** User and assistant messages read from the journal tail. `olderUnread`
 * means earlier messages exist but were not fetched because the newer ones
 * already fill the byte budget. */
export type ConversationTranscript = { entries: TimelineEntry[]; olderUnread: boolean };

/** Replays the whole journal and returns the user and assistant messages in
 * order. Process steps (tools, reasoning, approvals) are not part of a
 * transcript. Prefer `fetchConversationTranscriptTail` when the output has a
 * byte budget: it only reads the history the budget can show. */
export async function fetchConversationTranscript(replay: Replay, conversationId: string, workspaceId: string): Promise<TimelineEntry[]> {
  let state = createConversationRuntime(conversationId, workspaceId);
  for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
    const cursor = state.appliedSequence;
    const result = await replay(conversationId, cursor, EXPORT_PAGE_LIMIT);
    state = applyConversationRuntimeEvents(state, result.events).state;
    if (!result.hasMore && state.appliedSequence >= state.highWaterSequence) {
      return transcriptEntries(state.timeline);
    }
    if (state.appliedSequence <= cursor) {
      throw new Error(`Conversation history has a gap after event ${cursor}`);
    }
  }
  throw new Error('Conversation history is too long to export');
}

/** Pages the journal backwards from its tail and returns the user and
 * assistant messages in order, like `fetchConversationTranscript`. With
 * `maxBytes` it stops once the messages read so far already overflow the
 * budget `conversationTranscriptMarkdown` applies, so a long conversation
 * reads (and decrypts) only its newest pages. Pages merge through the same
 * projection lazily opened conversations use, so a message split across a
 * page boundary comes out whole; the one message that may still continue
 * below the oldest page read is left out when reading stops early. */
export async function fetchConversationTranscriptTail(
  replayBefore: ReplayBefore,
  conversationId: string,
  workspaceId: string,
  options: ConversationTranscriptOptions,
): Promise<ConversationTranscript> {
  let state: ConversationRuntime | null = null;
  // The backend clamps the cursor to the journal's newest event.
  let cursor = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
    const result = await replayBefore(conversationId, cursor, EXPORT_PAGE_LIMIT);
    const events = result.events;
    // A backend without reverse paging answers with the journal head.
    if (events.some((event) => event.sequence > cursor) || (result.hasMore && (events[0]?.sequence ?? 0) <= 1)) {
      throw new Error('The backend does not page conversation history backwards');
    }
    if (!events.length) return { entries: state ? transcriptEntries(state.timeline) : [], olderUnread: false };
    const first = events[0].sequence;
    const last = events[events.length - 1].sequence;
    const hasMore = result.hasMore;
    if ((state && last !== cursor) || last - first !== events.length - 1 || (!hasMore && first > 1)) {
      throw new Error(`Conversation history has a gap before event ${state ? cursor + 1 : last}`);
    }
    // The first page is seeded like a lazily opened conversation: everything
    // below it is history, not a gap. Older pages merge in underneath.
    state = state
      ? prependConversationRuntimeEvents(state, events)
      : applyConversationRuntimeEvents(createConversationRuntime(conversationId, workspaceId, first - 1), events).state;
    if (!hasMore) return { entries: transcriptEntries(state.timeline), olderUnread: false };
    if (options.maxBytes) {
      // The segment the loaded window opened with may continue below it.
      const partial = state.floorAssistantSegment;
      const complete = transcriptEntries(state.timeline).filter((entry) => entry.id !== partial);
      if (overflowsBudget(complete, { ...options, olderUnread: true })) return { entries: complete, olderUnread: true };
    }
    cursor = first - 1;
  }
  throw new Error('Conversation history is too long to export');
}

export function transcriptEntries(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline
    .filter((entry) => (entry.kind === 'outgoing' || entry.kind === 'incoming') && entry.subtitle.trim())
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.at - right.at);
}

const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).length;
const transcriptHeader = (options: ConversationTranscriptOptions) => `# ${options.title.trim() || 'Conversation'}\n`;
const transcriptSection = (entry: TimelineEntry) =>
  `## ${entry.kind === 'outgoing' ? 'User' : 'Assistant'}\n\n${entry.subtitle.trim()}\n`;
const omittedNote = (count: number, olderUnread?: boolean) =>
  olderUnread ? '> Earlier messages omitted.\n' : `> ${count} earlier message(s) omitted.\n`;

/** Index of the oldest section kept when the newest ones fill `maxBytes`,
 * and the bytes left after them. Reserves room for the omission note. */
function keptSections(sections: readonly string[], options: ConversationTranscriptOptions & { maxBytes: number }): { first: number; budget: number } {
  let budget = options.maxBytes - byteSize(transcriptHeader(options)) - byteSize(omittedNote(sections.length, options.olderUnread)) - 2;
  let first = sections.length;
  while (first > 0) {
    const cost = byteSize(sections[first - 1]) + 1;
    if (cost > budget) break;
    budget -= cost;
    first--;
  }
  return { first, budget };
}

/** Whether the budget already drops at least one of `entries`. */
function overflowsBudget(entries: readonly TimelineEntry[], options: ConversationTranscriptOptions): boolean {
  return Boolean(options.maxBytes) && entries.length > 0
    && keptSections(entries.map(transcriptSection), { ...options, maxBytes: options.maxBytes! }).first > 0;
}

/** Renders a transcript as Markdown. Message bodies are already Markdown, so
 * they are embedded verbatim under a role heading. */
export function conversationTranscriptMarkdown(entries: readonly TimelineEntry[], options: ConversationTranscriptOptions): string {
  const header = transcriptHeader(options);
  const sections = entries.map(transcriptSection);
  const maxBytes = options.maxBytes;
  if (!maxBytes) return [header, ...(options.olderUnread ? [omittedNote(0, true)] : []), ...sections].join('\n');
  // Keep the newest messages that fit, reserving room for the omission note.
  const fit = keptSections(sections, { ...options, maxBytes });
  let first = fit.first;
  const kept = sections.slice(first);
  if (!kept.length && sections.length) {
    // The newest message alone exceeds the budget: keep its beginning.
    const truncated = new TextDecoder().decode(encoder.encode(sections[sections.length - 1]).slice(0, Math.max(0, fit.budget - 1)));
    kept.push(`${truncated.replace(/�$/, '')}\n`);
    first = sections.length - 1;
  }
  return [header, ...(first > 0 || options.olderUnread ? [omittedNote(first, options.olderUnread)] : []), ...kept].join('\n');
}
