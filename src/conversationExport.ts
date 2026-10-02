import { applyConversationRuntimeEvents, createConversationRuntime } from './conversationRuntime';
import type { TimelineEntry } from './mobileParity';
import type { ConversationReplay } from './v2';

type Replay = (conversationId: string, afterSequence: number, limit: number) => Promise<ConversationReplay>;

/** Events per page; the backend caps replay pages at 1000. */
const EXPORT_PAGE_LIMIT = 1000;
/** Upper bound on pages so a journal that never reports the end cannot loop forever. */
const EXPORT_MAX_PAGES = 10_000;

export type ConversationTranscriptOptions = {
  title: string;
  /** Byte budget for the whole document. Older messages are dropped first
   * and the document notes how many were left out. */
  maxBytes?: number;
};

/** Replays the whole journal and returns the user and assistant messages in
 * order. Process steps (tools, reasoning, approvals) are not part of a
 * transcript. */
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

export function transcriptEntries(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline
    .filter((entry) => (entry.kind === 'outgoing' || entry.kind === 'incoming') && entry.subtitle.trim())
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.at - right.at);
}

/** Renders a transcript as Markdown. Message bodies are already Markdown, so
 * they are embedded verbatim under a role heading. */
export function conversationTranscriptMarkdown(entries: readonly TimelineEntry[], options: ConversationTranscriptOptions): string {
  const header = `# ${options.title.trim() || 'Conversation'}\n`;
  const sections = entries.map((entry) =>
    `## ${entry.kind === 'outgoing' ? 'User' : 'Assistant'}\n\n${entry.subtitle.trim()}\n`);
  const maxBytes = options.maxBytes;
  if (!maxBytes) return [header, ...sections].join('\n');
  const encoder = new TextEncoder();
  const size = (text: string) => encoder.encode(text).length;
  // Keep the newest messages that fit, reserving room for the omission note.
  const omittedNote = (count: number) => `> ${count} earlier message(s) omitted.\n`;
  let budget = maxBytes - size(header) - size(omittedNote(entries.length)) - 2;
  let first = sections.length;
  while (first > 0) {
    const cost = size(sections[first - 1]) + 1;
    if (cost > budget) break;
    budget -= cost;
    first--;
  }
  const kept = sections.slice(first);
  if (!kept.length && sections.length) {
    // The newest message alone exceeds the budget: keep its beginning.
    const truncated = new TextDecoder().decode(encoder.encode(sections[sections.length - 1]).slice(0, Math.max(0, budget - 1)));
    kept.push(`${truncated.replace(/�$/, '')}\n`);
    first = sections.length - 1;
  }
  return [header, ...(first > 0 ? [omittedNote(first)] : []), ...kept].join('\n');
}
