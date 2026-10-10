import { applyConversationRuntimeEvents, createConversationRuntime, prependConversationRuntimeEvents, type ConversationRuntime } from './conversationRuntime';
import { isVisibleConversationEntry, type TimelineEntry } from './mobileParity';
import { describeToolCall } from './toolPresentation';
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

/** Transcript entries read from the journal tail. `olderUnread` means
 * earlier entries exist but were not fetched because the newer ones
 * already fill the byte budget. */
export type ConversationTranscript = { entries: TimelineEntry[]; olderUnread: boolean };

/** Replays the whole journal and returns the transcript entries (see
 * `transcriptEntries`) in order. Replay with full detail: summary pages leave
 * process steps as empty placeholders. Prefer `fetchConversationTranscriptTail` when the output has a
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

/** Pages the journal backwards from its tail and returns the transcript
 * entries in order, like `fetchConversationTranscript`. With
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

/** Process steps a transcript keeps besides the messages, by category.
 * Events without a block category are recognized by their projected title,
 * like `isStepProgressEntry` does. Usage rows and client-local notices carry
 * nothing worth debugging a run with. */
const STEP_TITLES: Record<string, string> = {
  '工具调用': 'tool', '思考中': 'reasoning', '请求权限批准': 'approval', '运行异常': 'error',
  '执行步骤': 'status', '步骤完成': 'status',
};
const STEP_CATEGORIES: ReadonlySet<string> = new Set(['assistant_progress', ...Object.values(STEP_TITLES)]);
const stepCategory = (entry: TimelineEntry) => entry.category ?? STEP_TITLES[entry.title] ?? '';

function isTranscriptEntry(entry: TimelineEntry): boolean {
  if (entry.kind === 'outgoing' || entry.kind === 'incoming') return Boolean(entry.subtitle.trim());
  if (entry.detailLocked) return true;
  if (entry.category !== 'assistant_progress' && !isVisibleConversationEntry(entry)) return false;
  return STEP_CATEGORIES.has(stepCategory(entry)) && Boolean(entry.subtitle.trim() || entry.detailStub);
}

/** User and assistant messages plus the process steps between them (tool
 * calls, reasoning, approvals, errors), in journal order. */
export function transcriptEntries(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline
    .filter(isTranscriptEntry)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0) || left.at - right.at);
}

const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).length;
const transcriptHeader = (options: ConversationTranscriptOptions) => `# ${options.title.trim() || 'Conversation'}\n`;
const omittedNote = (count: number, olderUnread?: boolean) =>
  olderUnread ? '> Earlier messages omitted.\n' : `> ${count} earlier message(s) omitted.\n`;
const roleOf = (entry: TimelineEntry) => entry.kind === 'outgoing' ? 'User' : 'Assistant';

/** A fenced code block whose fence outruns any backtick run in `text`. */
function fenced(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`;
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const STEP_LABELS: Record<string, string> = {
  assistant_progress: 'Progress', reasoning: 'Reasoning', tool: 'Tool call',
  approval: 'Approval request', error: 'Error', status: 'Status',
};

/** A tool call with its arguments, result and error in code blocks. */
function toolStep(subtitle: string): string {
  const tool = describeToolCall(subtitle);
  const summary = tool.summary ? ` — ${tool.summary.replace(/\s+/g, ' ')}` : '';
  const parts = [`**Tool call: ${tool.name || tool.kind}** (${tool.status})${summary}`];
  if (tool.argsText) parts.push(`Arguments:\n\n${fenced(tool.argsText, isJson(tool.argsText) ? 'json' : '')}`);
  if (tool.outputText) parts.push(`Result:\n\n${fenced(tool.outputText, isJson(tool.outputText) ? 'json' : '')}`);
  if (tool.errorText) parts.push(`Error:\n\n${fenced(tool.errorText)}`);
  return parts.join('\n\n');
}

/** A process step as a quote, so it stays apart from the assistant's words. */
function stepMarkdown(entry: TimelineEntry): string {
  const text = entry.subtitle.trim();
  const category = stepCategory(entry);
  const label = STEP_LABELS[category] ?? entry.title;
  const body = entry.detailLocked ? `**Encrypted step** — ${text}`
    : entry.detailStub ? `**${label}** (details not loaded)`
    : category === 'tool' ? toolStep(text)
    : category === 'error' || category === 'approval' ? `**${label}**\n\n${fenced(text)}`
    : category === 'status' ? `**${label}:** ${text}`
    : `**${label}**\n\n${text}`;
  return `${body.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')}\n`;
}

/** An entry without its role heading. Messages are already Markdown and are
 * embedded verbatim; process steps are quoted. */
const entryBody = (entry: TimelineEntry) =>
  entry.kind === 'system' ? stepMarkdown(entry) : `${entry.subtitle.trim()}\n`;

/** Each entry rendered with its role heading (`headed`) and as it appears
 * after the previous entry (`inline`), where a run of the same role shares
 * one heading. */
function transcriptSections(entries: readonly TimelineEntry[]): { headed: string[]; inline: string[] } {
  const headed = entries.map((entry) => `## ${roleOf(entry)}\n\n${entryBody(entry)}`);
  const inline = entries.map((entry, index) =>
    index > 0 && roleOf(entries[index - 1]) === roleOf(entry) ? entryBody(entry) : headed[index]);
  return { headed, inline };
}

/** Index of the oldest section kept when the newest ones fill `maxBytes`,
 * and the bytes left after them. The oldest kept section always carries its
 * role heading. Reserves room for the omission note. */
function keptSections(
  sections: { headed: readonly string[]; inline: readonly string[] },
  options: ConversationTranscriptOptions & { maxBytes: number },
): { first: number; budget: number } {
  const { headed, inline } = sections;
  const budget = options.maxBytes - byteSize(transcriptHeader(options)) - byteSize(omittedNote(headed.length, options.olderUnread)) - 2;
  let first = headed.length;
  let used = 0;
  while (first > 0) {
    const below = first < headed.length ? used - byteSize(headed[first]) + byteSize(inline[first]) : 0;
    const cost = below + byteSize(headed[first - 1]) + 1;
    if (cost > budget) break;
    used = cost;
    first--;
  }
  return { first, budget: budget - used };
}

/** Whether the budget already drops at least one of `entries`. */
function overflowsBudget(entries: readonly TimelineEntry[], options: ConversationTranscriptOptions): boolean {
  return Boolean(options.maxBytes) && entries.length > 0
    && keptSections(transcriptSections(entries), { ...options, maxBytes: options.maxBytes! }).first > 0;
}

/** Renders a transcript as Markdown: messages under role headings, process
 * steps quoted between them with tool arguments and results in code blocks. */
export function conversationTranscriptMarkdown(entries: readonly TimelineEntry[], options: ConversationTranscriptOptions): string {
  const header = transcriptHeader(options);
  const sections = transcriptSections(entries);
  const maxBytes = options.maxBytes;
  if (!maxBytes) return [header, ...(options.olderUnread ? [omittedNote(0, true)] : []), ...sections.inline].join('\n');
  // Keep the newest entries that fit, reserving room for the omission note.
  const fit = keptSections(sections, { ...options, maxBytes });
  let first = fit.first;
  const kept = first < entries.length ? [sections.headed[first], ...sections.inline.slice(first + 1)] : [];
  if (!kept.length && entries.length) {
    // The newest entry alone exceeds the budget: keep its beginning.
    const truncated = new TextDecoder().decode(encoder.encode(sections.headed[entries.length - 1]).slice(0, Math.max(0, fit.budget - 1)));
    kept.push(`${truncated.replace(/\uFFFD$/, '')}\n`);
    first = entries.length - 1;
  }
  return [header, ...(first > 0 || options.olderUnread ? [omittedNote(first, options.olderUnread)] : []), ...kept].join('\n');
}
