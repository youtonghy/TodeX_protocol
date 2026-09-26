/** Shared deterministic projection for both realtime delivery and history replay. */
import { canonicalConversationEventType, contextCompactionStatus, normalizeConversationEvent } from './v2';
import type { ConversationEvent, ContextCompactionState, ExtensionScope, MemoryEntry, ProviderRuntimeState, SubagentRun } from './v2';
import { classifyV2ConversationEvent, contextUsageFromV2Event, isStepProgressEntry, shouldAppendV2ConversationEvent, usageRecordFromV2Event } from './mobileParity';
import type { ConversationContextUsage, TimelineEntry, UsageRecord } from './mobileParity';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export type RuntimePermission = { id: string; turnId: string; scope?: ExtensionScope; runtimeId?: string; event: ConversationEvent; payload: RecordValue };
export type RuntimeCompaction = ContextCompactionState & { recommended: boolean };
export type NativeQueueItem = { id: string; text: string; status: string };
type ExtensionEventIdentity = { runtimeId: string; eventId: string; sequence: number };
export type ExtensionStatus = ExtensionEventIdentity & { key: string; text: string };
export type ExtensionWidget = ExtensionEventIdentity & { key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor' };
export type ExtensionEditorRequest = ExtensionEventIdentity & { text: string };
export type ExtensionNotice = ExtensionEventIdentity & {
  message: string; level: 'info' | 'warning' | 'error'; time: string; scope: ExtensionScope;
};
export type ExtensionUiState = {
  runtimeId: string;
  statuses: Record<string, ExtensionStatus>;
  widgets: Record<string, ExtensionWidget>;
  title?: string;
  editorRequest?: ExtensionEditorRequest;
  notices: ExtensionNotice[];
};
const LEGACY_PI_RUNTIME = 'legacy:pi';
function createExtensionUi(runtimeId = '', notices: ExtensionNotice[] = []): ExtensionUiState {
  return { runtimeId, statuses: {}, widgets: {}, notices };
}

export type ConversationRuntime = {
  conversationId: string;
  workspaceId: string;
  appliedSequence: number;
  highWaterSequence: number;
  pendingEvents: Record<number, ConversationEvent>;
  timeline: TimelineEntry[];
  activeTurnId: string;
  status: 'idle' | 'running' | 'waitingPermission' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  usageRecords: UsageRecord[];
  contextUsage: ConversationContextUsage | null;
  cumulativeUsage: Record<string, number> | null;
  subagents: SubagentRun[];
  compaction: RuntimeCompaction;
  memoryEntries: MemoryEntry[];
  pendingPermissions: RuntimePermission[];
  extensionUi: ExtensionUiState;
  providerRuntime?: ProviderRuntimeState;
  /** Retired native instances cannot become current again through delayed frames. */
  retiredRuntimeIds: string[];
  requestedConfig: RecordValue | null;
  effectiveConfig: RecordValue | null;
  configurationStatus: 'unknown' | 'validated' | 'provider-confirmed' | 'pending' | 'rejected';
  configurationRequestId?: string;
  pendingControl?: { requestId: string; turnId: string; status: 'pending' | 'unknown' };
  configurationError?: string;
  messageCategories: Record<string, string>;
  /** Sequence of the chunk that opened the current segment of the shared
   * assistant stream (0: none open). Activity between two chunks starts a new
   * segment so narration interleaves with folded steps; naming segments by
   * their first sequence keeps ids stable however much history is loaded. */
  assistantSegmentStart: number;
  assistantStreamInterrupted: boolean;
  /** How the loaded window's stream began, for joining history paged in below
   * it: the id of the segment its first chunk opened before anything
   * interrupted the stream, `null` when a turn start or step came first, and
   * undefined while nothing decided it yet. */
  floorAssistantSegment?: string | null;
  queueItems: NativeQueueItem[];
  queuePaused: boolean;
  lastProgressAt: string | null;
};
export function createConversationRuntime(conversationId: string, workspaceId: string, appliedSequence = 0): ConversationRuntime {
  return {
    conversationId, workspaceId, appliedSequence, highWaterSequence: 0, pendingEvents: {},
    timeline: [], activeTurnId: '', status: 'idle', usageRecords: [], contextUsage: null, cumulativeUsage: null,
    subagents: [], compaction: { status: 'idle', recommended: false, updatedAt: '' }, memoryEntries: [],
    messageCategories: {}, assistantSegmentStart: 0, assistantStreamInterrupted: false, queueItems: [], queuePaused: false,
    extensionUi: createExtensionUi(), retiredRuntimeIds: [],
    pendingPermissions: [], requestedConfig: null, effectiveConfig: null, configurationStatus: 'unknown', lastProgressAt: null,
  };
}

/** Cached tokens are a subset for included semantics; unknown counts are never added twice. */
export function usageTotalTokens(record: UsageRecord): number {
  return record.totalTokens ?? record.inputTokens + record.outputTokens
    + (record.cacheSemantics === 'additional' ? record.cachedInputTokens + record.cacheWriteTokens : 0);
}
export function upsertUsageRecord(records: UsageRecord[], record: UsageRecord, limit = 2000): UsageRecord[] {
  const previous = records.find(item => item.id === record.id);
  if (previous && (previous.sequence ?? 0) > (record.sequence ?? 0)) return records;
  return [record, ...records.filter(item => item.id !== record.id)].slice(0, limit);
}
function usageProjection(state: ConversationRuntime, event: ConversationEvent, turnId: string): void {
  const usage = contextUsageFromV2Event(event);
  if (!usage) return;
  state.contextUsage = usage;
  state.compaction = { ...state.compaction, usedTokens: usage.usedTokens, contextWindow: usage.contextWindow,
    recommended: contextCompactionStatus(usage.usedTokens, usage.contextWindow) === 'recommended' };
  const payload = object(event.payload);
  const provider = string(event.provider) || string(payload.provider) || 'unknown';
  const raw = usageRecordFromV2Event(event, { provider });
  if (!raw) return;
  const normalized = object(payload.usage);
  const tokenUsage = object(payload.tokenUsage ?? object(payload.metadata).tokenUsage);
  const cumulative = object(normalized.cumulative ?? tokenUsage.total);
  const read = (primary: string, alias: string) => number(cumulative[primary] ?? cumulative[alias]);
  const cacheSemantics = string(normalized.cacheSemantics ?? payload.cacheSemantics);
  const semantics: UsageRecord['cacheSemantics'] = cacheSemantics === 'included' || cacheSemantics === 'additional'
    ? cacheSemantics : provider === 'codex' ? 'included' : provider === 'claude-code' ? 'additional' : 'unknown';
  let record: UsageRecord = { ...raw, turnId: turnId || undefined, sequence: event.sequence,
    scope: turnId ? 'turn' : 'unknown', cacheSemantics: semantics };
  if (Object.keys(cumulative).length > 0) {
    const counters = { inputTokens: read('input', 'inputTokens'), outputTokens: read('output', 'outputTokens'),
      cachedInputTokens: read('cacheRead', 'cachedInputTokens'), cacheWriteTokens: read('cacheWrite', 'cacheWriteInputTokens'),
      totalTokens: read('total', 'totalTokens') };
    // Session counters can reset on process replacement. The new epoch starts at zero.
    const prior = state.cumulativeUsage;
    const reset = prior && Object.keys(counters).some(key => counters[key as keyof typeof counters] < (prior[key] ?? 0));
    const baseline = reset ? null : prior;
    const id = `${state.conversationId}:usage:${turnId || 'unattributed'}`;
    const previous = state.usageRecords.find(item => item.id === id);
    record = { ...record, id };
    for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
      record[key] = (previous?.[key] ?? 0) + Math.max(0, counters[key] - (baseline?.[key] ?? 0));
    }
    if (!counters.totalTokens) record.totalTokens = record.inputTokens + record.outputTokens;
    state.cumulativeUsage = counters;
  } else {
    const message = object(payload.message);
    const messageId = string(payload.messageId ?? message.id ?? object(payload.block).id);
    const requestId = string(payload.usageId ?? payload.requestId);
    const messageScope = payload.scope === 'message' || canonicalConversationEventType(event) === 'message.completed';
    // Equal token values cannot prove two provider calls were the same call.
    const identity = messageId || requestId || (messageScope ? event.eventId : turnId || event.eventId);
    record.id = `${state.conversationId}:usage:${identity}`;
    record.scope = messageId || requestId || messageScope ? 'request' : turnId ? 'turn' : 'unknown';
    const explicitTotal = object(normalized.last).total ?? normalized.totalTokens ?? normalized.total_tokens ?? normalized.total
      ?? object(message.usage).totalTokens ?? object(message.usage).total_tokens ?? object(message.usage).total;
    if (typeof explicitTotal === 'number') record.totalTokens = number(explicitTotal);
  }
  // A provider's final turn snapshot supersedes its earlier per-request usage.
  if (payload.scope === 'turn' && payload.aggregation === 'snapshot' && payload.final === true && turnId) {
    state.usageRecords = state.usageRecords.filter(item => item.turnId !== turnId);
    record = { ...record, id: `${state.conversationId}:usage:${turnId}`, scope: 'turn' };
  }
  state.usageRecords = upsertUsageRecord(state.usageRecords, record);
}

function permissionScope(payload: RecordValue): ExtensionScope {
  return (payload.scope ?? object(payload.details).scope) === 'session' ? 'session' : 'turn';
}
function permissionRuntimeId(payload: RecordValue): string {
  return string(payload.runtimeId ?? object(payload.details).runtimeId);
}
function clearRuntimePermissions(state: ConversationRuntime, runtimeId: string): void {
  state.pendingPermissions = state.pendingPermissions.filter(item => item.runtimeId !== runtimeId);
  if (state.status === 'waitingPermission' && !state.pendingPermissions.some(item => item.scope !== 'session')) {
    state.status = state.activeTurnId ? 'running' : 'idle';
  }
}
function activateExtensionRuntime(state: ConversationRuntime, runtimeId: string): void {
  const previous = state.extensionUi.runtimeId;
  if (previous === runtimeId) return;
  if (previous) {
    state.retiredRuntimeIds = [...state.retiredRuntimeIds, previous];
    clearRuntimePermissions(state, previous);
  }
  state.extensionUi = createExtensionUi(runtimeId, state.extensionUi.notices);
}
function acceptsRuntimeFrame(state: ConversationRuntime, runtimeId: string): boolean {
  if (!runtimeId || state.retiredRuntimeIds.includes(runtimeId)) return false;
  if (!state.extensionUi.runtimeId) activateExtensionRuntime(state, runtimeId);
  return state.extensionUi.runtimeId === runtimeId
    && !(state.providerRuntime?.runtimeId === runtimeId && state.providerRuntime.status === 'stopped');
}
/** Older backends journalled non-dialog UI requests as opaque provider events. */
function piUiPayload(event: ConversationEvent): RecordValue | undefined {
  const payload = object(event.payload);
  const type = canonicalConversationEventType(event);
  if (type === 'extension.ui') return payload;
  if (type !== 'provider.event' || (payload.provider ?? event.provider) !== 'pi') return undefined;
  const metadata = object(payload.metadata);
  if (payload.providerMethod !== 'extension_ui_request' && metadata.type !== 'extension_ui_request') return undefined;
  return { ...metadata, runtimeId: payload.runtimeId ?? metadata.runtimeId ?? LEGACY_PI_RUNTIME,
    scope: payload.scope ?? metadata.scope ?? 'session' };
}
/** Returns true for events whose effects are confined to the extension surface. */
function projectExtensionEvent(state: ConversationRuntime, event: ConversationEvent): boolean {
  const type = canonicalConversationEventType(event);
  const payload = object(event.payload);
  if (type === 'provider.runtime') {
    const runtimeId = string(payload.runtimeId);
    const status = payload.status;
    if ((payload.provider ?? event.provider) !== 'pi' || !runtimeId || (status !== 'ready' && status !== 'stopped')) return true;
    if (state.retiredRuntimeIds.includes(runtimeId)) return true;
    if (status === 'ready') {
      if (state.providerRuntime?.runtimeId === runtimeId && state.providerRuntime.status === 'stopped') return true;
      activateExtensionRuntime(state, runtimeId);
    } else {
      if (state.extensionUi.runtimeId && state.extensionUi.runtimeId !== runtimeId) return true;
      activateExtensionRuntime(state, runtimeId);
      state.extensionUi = createExtensionUi(runtimeId, state.extensionUi.notices);
      clearRuntimePermissions(state, runtimeId);
    }
    state.providerRuntime = { provider: 'pi', runtimeId, status,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}) };
    return true;
  }
  const request = piUiPayload(event);
  if (!request) return false;
  const runtimeId = string(request.runtimeId) || LEGACY_PI_RUNTIME;
  if (!acceptsRuntimeFrame(state, runtimeId)) return true;
  const identity = { runtimeId, eventId: event.eventId, sequence: event.sequence };
  const ui = state.extensionUi;
  switch (request.method) {
    case 'notify': {
      if (typeof request.message !== 'string' || !request.message) break;
      const level = request.notifyType === 'error' || request.notifyType === 'warning' ? request.notifyType : 'info';
      const notice: ExtensionNotice = { ...identity, message: request.message, level, time: event.time,
        scope: request.scope === 'turn' ? 'turn' : 'session' };
      state.extensionUi = { ...ui, notices: [...ui.notices.filter(item => item.eventId !== event.eventId), notice].slice(-200) };
      break;
    }
    case 'setStatus': {
      const key = string(request.statusKey);
      if (!key) break;
      const statuses = typeof request.statusText === 'string'
        ? { ...ui.statuses, [key]: { ...identity, key, text: request.statusText } } : { ...ui.statuses };
      if (typeof request.statusText !== 'string') delete statuses[key];
      state.extensionUi = { ...ui, statuses };
      break;
    }
    case 'setWidget': {
      const key = string(request.widgetKey);
      if (!key) break;
      const widget: ExtensionWidget | undefined = Array.isArray(request.widgetLines) ? { ...identity, key,
        lines: request.widgetLines.filter((line): line is string => typeof line === 'string'),
        placement: request.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' } : undefined;
      const widgets = widget ? { ...ui.widgets, [key]: widget } : { ...ui.widgets };
      if (!widget) delete widgets[key];
      state.extensionUi = { ...ui, widgets };
      break;
    }
    case 'setTitle':
      state.extensionUi = { ...ui, title: typeof request.title === 'string' ? request.title : undefined };
      break;
    case 'set_editor_text':
    case 'setEditorText':
      if (typeof request.text === 'string') state.extensionUi = { ...ui, editorRequest: { ...identity, text: request.text } };
      break;
  }
  return true;
}

/** A final answer names the progress blocks its text was streamed under
 * (`block.supersedes`); those copies are dropped so the answer shows once.
 * Applied to whole timelines because hydrated or older pages can bring the
 * progress rows back after the final answer was projected. */
function dropSupersededProgressEntries(timeline: TimelineEntry[]): TimelineEntry[] {
  const superseded = new Set<string>();
  for (const entry of timeline) {
    if (entry.category !== 'assistant_final') continue;
    for (const blockId of entry.supersedes ?? []) superseded.add(`${entry.turnId ?? ''}\u0000${blockId}`);
  }
  if (!superseded.size) return timeline;
  const next = timeline.filter((entry) => entry.category !== 'assistant_progress'
    || !superseded.has(`${entry.turnId ?? ''}\u0000${entry.blockId ?? ''}`));
  return next.length === timeline.length ? timeline : next;
}

/** Lookup structures of one timeline array. Positions count from the oldest
 * row: a newest-first timeline only grows at the front, so they stay valid
 * while rows are added or replaced. */
type TimelineIndex = {
  positions: Map<string, number>;
  /** Assistant_progress row ids by `turnId\0blockId`. */
  progress: Map<string, Set<string>>;
  /** Final answers naming each `turnId\0blockId` in `supersedes`. */
  superseding: Map<string, number>;
  /** Progress rows a final answer in the timeline supersedes. */
  superseded: Set<string>;
};
/** Each index belongs to exactly one timeline array. A batch takes it from
 * the array it starts from and hands it to the array it produces, so arrays
 * that were never projected here (or were derived after rows were removed)
 * simply rebuild it once. */
const timelineIndexes = new WeakMap<readonly TimelineEntry[], TimelineIndex>();

const progressKey = (entry: TimelineEntry) => `${entry.turnId ?? ''}\u0000${entry.blockId ?? ''}`;
function supersededKeys(entry: TimelineEntry): string[] {
  if (entry.category !== 'assistant_final' || !entry.supersedes?.length) return [];
  return [...new Set(entry.supersedes.map((blockId) => `${entry.turnId ?? ''}\u0000${blockId}`))];
}
function indexEntry(index: TimelineIndex, entry: TimelineEntry): void {
  if (entry.category === 'assistant_progress') {
    const key = progressKey(entry);
    const ids = index.progress.get(key) ?? new Set<string>();
    ids.add(entry.id);
    index.progress.set(key, ids);
    if (index.superseding.has(key)) index.superseded.add(entry.id);
  }
  for (const key of supersededKeys(entry)) {
    const count = index.superseding.get(key) ?? 0;
    index.superseding.set(key, count + 1);
    if (!count) for (const id of index.progress.get(key) ?? []) index.superseded.add(id);
  }
}
function unindexEntry(index: TimelineIndex, entry: TimelineEntry): void {
  if (entry.category === 'assistant_progress') {
    const key = progressKey(entry);
    const ids = index.progress.get(key);
    ids?.delete(entry.id);
    if (ids && !ids.size) index.progress.delete(key);
    index.superseded.delete(entry.id);
  }
  for (const key of supersededKeys(entry)) {
    const count = (index.superseding.get(key) ?? 1) - 1;
    if (count > 0) { index.superseding.set(key, count); continue; }
    index.superseding.delete(key);
    for (const id of index.progress.get(key) ?? []) index.superseded.delete(id);
  }
}
function buildTimelineIndex(timeline: readonly TimelineEntry[]): TimelineIndex {
  const index: TimelineIndex = { positions: new Map(), progress: new Map(), superseding: new Map(), superseded: new Set() };
  // Oldest first, so a (never expected) duplicate id resolves to its newest row.
  for (let position = 0; position < timeline.length; position++) {
    const entry = timeline[timeline.length - 1 - position];
    index.positions.set(entry.id, position);
    indexEntry(index, entry);
  }
  return index;
}

/** A timeline under projection. Rows are looked up by id instead of scanned,
 * the base array is copied at most once per batch, and new rows collect
 * oldest-first until the batch finishes, so projecting a page is linear in
 * its events and a single delta costs no scan of the timeline. */
class TimelineDraft {
  private readonly index: TimelineIndex;
  private rows: Array<TimelineEntry | null> | null = null;
  private readonly added: Array<TimelineEntry | null> = [];
  private removed = false;
  changed = false;

  constructor(private readonly base: readonly TimelineEntry[]) {
    const cached = timelineIndexes.get(base);
    if (cached) timelineIndexes.delete(base);
    this.index = cached ?? buildTimelineIndex(base);
  }

  private at(position: number): TimelineEntry | null | undefined {
    const baseLength = this.base.length;
    if (position >= baseLength) return this.added[position - baseLength];
    return (this.rows ?? this.base)[baseLength - 1 - position];
  }

  private put(position: number, entry: TimelineEntry | null): void {
    const baseLength = this.base.length;
    if (position >= baseLength) {
      this.added[position - baseLength] = entry;
      return;
    }
    this.rows ??= this.base.slice();
    this.rows[baseLength - 1 - position] = entry;
  }

  get(id: string): TimelineEntry | undefined {
    const position = this.index.positions.get(id);
    return position === undefined ? undefined : this.at(position) ?? undefined;
  }

  /** Replace the row with the entry's id, or add the entry as the newest row. */
  set(entry: TimelineEntry): void {
    this.changed = true;
    const position = this.index.positions.get(entry.id);
    const existing = position === undefined ? undefined : this.at(position);
    if (position !== undefined && existing) {
      unindexEntry(this.index, existing);
      this.put(position, entry);
    } else {
      this.index.positions.set(entry.id, this.base.length + this.added.length);
      this.added.push(entry);
    }
    indexEntry(this.index, entry);
  }

  /** The draft's rows as dropSupersededProgressEntries would leave them. */
  dropSuperseded(): void {
    if (!this.index.superseded.size) return;
    this.changed = true;
    for (const id of [...this.index.superseded]) {
      const position = this.index.positions.get(id)!;
      unindexEntry(this.index, this.at(position)!);
      this.index.positions.delete(id);
      this.put(position, null);
    }
    this.removed = true;
  }

  /** The projected newest-first timeline; the base array while unchanged. */
  finish(): TimelineEntry[] {
    if (!this.changed) {
      timelineIndexes.set(this.base, this.index);
      return this.base as TimelineEntry[];
    }
    const older = this.rows ?? this.base;
    let timeline: TimelineEntry[];
    if (this.removed) {
      timeline = [...this.added].reverse().concat(older).filter((entry): entry is TimelineEntry => entry !== null);
    } else if (!this.added.length) {
      timeline = older as TimelineEntry[];
    } else {
      timeline = ([...this.added].reverse() as TimelineEntry[]).concat(older as TimelineEntry[]);
    }
    // Removing rows shifts positions; the next batch rebuilds the index.
    if (!this.removed) timelineIndexes.set(timeline, this.index);
    return timeline;
  }
}

/** Streamed text continues the row's earlier text; the reply placeholder is
 * replaced rather than kept as a prefix. */
function appendedSubtitle(earlier: TimelineEntry, later: TimelineEntry): string {
  return `${earlier.subtitle === '正在回复...' ? '' : earlier.subtitle}${later.subtitle}`;
}

function projectEvent(state: ConversationRuntime, event: ConversationEvent, timeline: TimelineDraft): void {
  const payload = object(event.payload);
  const type = canonicalConversationEventType(event);
  if (projectExtensionEvent(state, event)) return;
  const scopedRuntimeId = permissionRuntimeId(payload);
  if (type === 'extension.message' && !acceptsRuntimeFrame(state, string(payload.runtimeId) || LEGACY_PI_RUNTIME)) return;
  if ((type === 'permission.requested' || type === 'permission.resolved' || type === 'tool.awaitingApproval')
    && scopedRuntimeId && !acceptsRuntimeFrame(state, scopedRuntimeId)) return;
  const block = object(payload.block);
  const explicitTurnId = string(payload.turnId ?? payload.turn_id ?? block.turnId);
  const sessionScoped = ['extension.message', 'permission.requested', 'permission.resolved', 'tool.awaitingApproval'].includes(type)
    && permissionScope(payload) === 'session';
  const turnId = sessionScoped ? '' : explicitTurnId || state.activeTurnId;
  if (type === 'turn.started') {
    state.activeTurnId = explicitTurnId;
    state.messageCategories = {};
    state.assistantSegmentStart = 0;
    state.assistantStreamInterrupted = false;
    if (state.floorAssistantSegment === undefined) state.floorAssistantSegment = null;
    state.status = 'running';
    state.requestedConfig = payload.requestedPermissions ? object(payload.requestedPermissions) : null;
    state.effectiveConfig = payload.effectivePermissions
      ? { ...object(payload.effectivePermissions), source: 'locally-validated' } : null;
    state.configurationStatus = payload.configurationStatus === 'validated' ? 'validated' : 'unknown';
  }
  // Codex deltas have no phase. Keep the category advertised by item/started
  // for this native item instead of promoting commentary into the final answer.
  const messageKey = `${turnId}:${string(block.id)}`;
  let projectedEvent = event;
  if (block.category === 'assistant_final' || block.category === 'assistant_progress') {
    if (block.phase === 'started' || block.phase === 'completed') {
      state.messageCategories = { ...state.messageCategories, [messageKey]: string(block.category) };
    } else if (state.messageCategories[messageKey]) {
      projectedEvent = { ...event, payload: { ...payload, block: { ...block, category: state.messageCategories[messageKey] } } };
    }
  }
  const classifiedEntry = classifyV2ConversationEvent(projectedEvent, state.workspaceId, turnId);
  // The generic assistant stream shares one entry per turn. A step between
  // two chunks means the agent moved on, so the next chunk opens a new
  // segment instead of growing the previous text into one blob.
  if (classifiedEntry && classifiedEntry.kind !== 'incoming') {
    state.assistantStreamInterrupted = true;
    if (state.floorAssistantSegment === undefined) state.floorAssistantSegment = null;
  }
  let segmentedId: string | undefined;
  if (classifiedEntry && classifiedEntry.kind === 'incoming' && classifiedEntry.id.startsWith('v2-assistant-')) {
    if (state.assistantStreamInterrupted || !state.assistantSegmentStart) {
      state.assistantSegmentStart = event.sequence;
      state.assistantStreamInterrupted = false;
    }
    segmentedId = `${classifiedEntry.id}#s${state.assistantSegmentStart}`;
    if (state.floorAssistantSegment === undefined) state.floorAssistantSegment = segmentedId;
  }
  const entry = classifiedEntry && segmentedId ? { ...classifiedEntry, id: segmentedId } : classifiedEntry;
  if (entry) {
    const existing = timeline.get(entry.id);
    const append = shouldAppendV2ConversationEvent(event);
    const next: TimelineEntry = existing && append
      ? { ...existing, ...entry, subtitle: appendedSubtitle(existing, entry) }
      : { ...entry, firstSequence: existing?.firstSequence ?? event.sequence, ...(!existing && append ? { streamedText: true } : {}) };
    timeline.set(next);
    if (next.supersedes?.length) timeline.dropSuperseded();
  }
  if (type === 'permission.requested' || type === 'tool.awaitingApproval') {
    const id = string(payload.permissionId ?? payload.requestId);
    const scope = permissionScope(payload);
    if (id) state.pendingPermissions = [...state.pendingPermissions.filter(item => item.id !== id),
      { id, turnId, scope, ...(scopedRuntimeId ? { runtimeId: scopedRuntimeId } : {}), event, payload }];
    if (id && scope !== 'session' && (!explicitTurnId || explicitTurnId === state.activeTurnId)) state.status = 'waitingPermission';
  }
  if (type === 'permission.resolved') {
    const id = string(payload.permissionId ?? payload.requestId);
    state.pendingPermissions = state.pendingPermissions.filter(item => item.id !== id);
    if (!state.pendingPermissions.some(item => item.scope !== 'session') && state.status === 'waitingPermission') state.status = state.activeTurnId ? 'running' : 'idle';
  }
  if (['turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.failed'].includes(type)) {
    state.pendingPermissions = state.pendingPermissions.filter(item => item.scope === 'session' || (explicitTurnId && item.turnId !== explicitTurnId));
    if (!explicitTurnId || !state.activeTurnId || explicitTurnId === state.activeTurnId) {
      state.activeTurnId = '';
      state.status = type === 'turn.failed' || (type === 'turn.completed' && payload.stopReason === 'error') ? 'failed' : type === 'turn.cancelled' ? 'cancelled' : type === 'turn.interrupted' ? 'interrupted' : 'completed';
    }
  }
  usageProjection(state, event, turnId);
  if (type.startsWith('compaction.')) {
    const phase = type.slice('compaction.'.length);
    if (['started', 'completed', 'failed', 'cancelled'].includes(phase)) {
      state.compaction = { ...state.compaction,
        status: phase === 'started' ? 'running' : phase === 'cancelled' ? 'idle' : phase as 'completed' | 'failed',
        updatedAt: event.time, summary: string(payload.summary) || undefined,
        error: phase === 'failed' ? string(payload.error ?? payload.message) || '上下文压缩失败' : undefined };
    }
  }
  if (type.startsWith('subagent.')) {
    const id = string(payload.subagentId ?? payload.agentId ?? payload.id);
    if (id) {
      const previous = state.subagents.find(item => item.id === id);
      const phase = type.slice('subagent.'.length);
      const status: SubagentRun['status'] = phase === 'started' ? 'running' : phase === 'completed' ? 'completed'
        : phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : previous?.status ?? 'queued';
      const run: SubagentRun = { ...previous,
        id, conversationId: state.conversationId,
        title: string(payload.title) || previous?.title || 'Subagent', task: string(payload.task ?? payload.prompt) || previous?.task || '',
        status,
        ...(typeof payload.result === 'string' ? { result: payload.result } : {}),
        ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
        provider: string(payload.provider) || previous?.provider,
        parentId: string(payload.parentId) || previous?.parentId,
        turnId: string(payload.turnId) || previous?.turnId,
        providerItemId: string(payload.providerItemId) || previous?.providerItemId,
        agentKind: string(payload.agentKind) || previous?.agentKind,
        agentId: string(payload.agentId) || previous?.agentId,
        outputFile: string(payload.outputFile ?? object(payload.metadata)?.outputFile) || previous?.outputFile,
        usage: object(payload.usage) as SubagentRun['usage'] ?? previous?.usage,
        metadata: object(payload.metadata) ?? previous?.metadata,
        ...(status === 'running' ? { startedAt: previous?.startedAt ?? event.time }
          : status !== 'queued' ? { finishedAt: event.time } : {}),
      };
      state.subagents = [run, ...state.subagents.filter(item => item.id !== id)];
    }
  }
  if (type === 'memory.updated' || type === 'memory.created') {
    const id = string(payload.memoryId ?? payload.id);
    const content = string(payload.content ?? payload.text);
    if (id && content) {
      const previous = state.memoryEntries.find(item => item.id === id);
      const memory: MemoryEntry = { id, content, scope: payload.scope === 'user' || payload.scope === 'workspace' ? payload.scope : 'conversation',
        source: string(payload.source) || undefined, createdAt: previous?.createdAt ?? event.time, updatedAt: event.time };
      state.memoryEntries = [memory, ...state.memoryEntries.filter(item => item.id !== id)];
    }
  } else if (type === 'memory.deleted') {
    state.memoryEntries = state.memoryEntries.filter(item => item.id !== string(payload.memoryId ?? payload.id));
  }
  if ((!explicitTurnId || !state.activeTurnId || explicitTurnId === state.activeTurnId)
    && (type === 'turn.configuration' || payload.effectiveConfig)) {
    if (payload.requested) state.requestedConfig = object(payload.requested);
    const effective = object(payload.effective ?? payload.effectiveConfig);
    state.effectiveConfig = { ...state.effectiveConfig, ...effective };
    state.configurationError = undefined;
    state.configurationStatus = effective.source === 'provider-confirmed' ? 'provider-confirmed' : 'unknown';
  }
  if (type === 'control.requested' && explicitTurnId === state.activeTurnId) {
    state.pendingControl = { requestId: string(payload.requestId), turnId: explicitTurnId, status: 'pending' };
  }
  if (type === 'control.unknown' && payload.requestId === state.pendingControl?.requestId) {
    state.pendingControl = { ...state.pendingControl!, status: 'unknown' };
  }
  if ((type === 'control.completed' || type === 'control.rejected') && payload.requestId === state.pendingControl?.requestId) {
    state.pendingControl = undefined;
  }
  if (!state.activeTurnId) state.pendingControl = undefined;
  if (type === 'control.requested' && object(payload.control).action === 'configure') {
    const { action: _, ...requested } = object(payload.control);
    state.requestedConfig = { ...state.requestedConfig, ...requested };
    state.configurationRequestId = string(payload.requestId);
    state.configurationStatus = 'pending';
    state.configurationError = undefined;
  }
  if ((type === 'control.rejected' || type === 'control.unknown') && payload.requestId === state.configurationRequestId) {
    state.configurationStatus = type === 'control.unknown' ? 'unknown' : 'rejected';
    state.configurationError = string(payload.message) || 'Agent 未应用这次配置';
  }
  if (type === 'control.completed' && payload.requestId === state.configurationRequestId
    && state.configurationStatus === 'pending') {
    // A transport ACK alone is not an effective-value readback.
    state.configurationStatus = 'unknown';
  }
  if (type === 'queue.updated' && Array.isArray(payload.items)) {
    state.queueItems = payload.items.flatMap((value) => {
      const item = object(value); const id = string(item.id ?? item.itemId);
      return id ? [{ id, text: string(item.text), status: string(item.status) || 'queued' }] : [];
    });
    state.queuePaused = payload.paused === true;
  }
  if (type === 'queue.paused' || ['turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(type)) {
    state.queuePaused = state.queueItems.length > 0;
  }
  state.lastProgressAt = event.time;
}

/** Project events in order on a fresh runtime of the same conversation. */
function projectScratchRuntime(previous: ConversationRuntime, events: readonly ConversationEvent[]): ConversationRuntime {
  const scratch = createConversationRuntime(previous.conversationId, previous.workspaceId);
  const timeline = new TimelineDraft(scratch.timeline);
  for (const event of events) projectEvent(scratch, event, timeline);
  scratch.timeline = timeline.finish();
  return scratch;
}

export type ConversationRuntimeUpdate = { state: ConversationRuntime; appliedEvents: ConversationEvent[]; missingSequences: number[] };
/** Never seed appliedSequence from a high-water mark or a truncated timeline. */
export function applyConversationRuntimeEvents(previous: ConversationRuntime, events: readonly ConversationEvent[]): ConversationRuntimeUpdate {
  const incoming = events.map(normalizeConversationEvent).filter((event): event is ConversationEvent =>
    event !== null && event.conversationId === previous.conversationId && event.sequence > previous.appliedSequence
    && !previous.pendingEvents[event.sequence]);
  // Continuous journal sequence is the authoritative delivery identity.
  if (!incoming.length) return { state: previous, appliedEvents: [], missingSequences: missingRuntimeSequences(previous) };
  const state: ConversationRuntime = { ...previous, pendingEvents: { ...previous.pendingEvents } };
  const appliedEvents: ConversationEvent[] = [];
  for (const event of incoming) {
    state.highWaterSequence = Math.max(state.highWaterSequence, event.sequence);
    if (!state.pendingEvents[event.sequence]) state.pendingEvents[event.sequence] = event;
  }
  const timeline = new TimelineDraft(state.timeline);
  while (state.pendingEvents[state.appliedSequence + 1]) {
    const event = state.pendingEvents[state.appliedSequence + 1];
    delete state.pendingEvents[event.sequence];
    state.appliedSequence = event.sequence;
    projectEvent(state, event, timeline);
    appliedEvents.push(event);
  }
  state.timeline = timeline.finish();
  return { state, appliedEvents, missingSequences: missingRuntimeSequences(state) };
}
function missingRuntimeSequences(state: ConversationRuntime): number[] {
  const missing: number[] = [];
  const end = Math.min(state.highWaterSequence, state.appliedSequence + 10000);
  for (let sequence = state.appliedSequence + 1; sequence <= end; sequence++) {
    if (!state.pendingEvents[sequence]) missing.push(sequence);
  }
  return missing;
}

/** Hydrate folded process entries after a `detail=summary` replay. Full events
 * for an expanded group's sequence range are projected on a scratch runtime —
 * their turn context comes from the events themselves — then merged back by
 * entry id, falling back to the covering stub's sequence when replay-time
 * context changed the id. Only folded-step entries merge: visible output
 * already arrived complete, and assistant segment ids depend on context
 * outside the range. Fetched stubs that project to no row are dropped so a
 * group cannot stay stuck on placeholders that will never resolve. */
export function hydrateConversationRuntimeEvents(
  previous: ConversationRuntime,
  events: readonly ConversationEvent[],
): ConversationRuntime {
  const normalized = events
    .map(normalizeConversationEvent)
    .filter((event): event is ConversationEvent =>
      event !== null && event.conversationId === previous.conversationId)
    .sort((left, right) => left.sequence - right.sequence);
  if (!normalized.length) return previous;
  const scratch = projectScratchRuntime(previous, normalized);
  const details = scratch.timeline.filter(isStepProgressEntry);
  const covered = new Set(normalized.map((event) => event.sequence));
  const timeline = [...previous.timeline];
  let changed = false;
  for (const entry of details) {
    const { detailStub: _stub, ...hydrated } = entry;
    const index = timeline.findIndex(item => item.id === entry.id);
    if (index >= 0) {
      // A hydrated block only spans the fetched range; never downgrade a row
      // the full stream already advanced past this event.
      const existing = timeline[index];
      if (!existing.detailStub && (existing.sequence ?? 0) > (entry.sequence ?? 0)) continue;
      timeline[index] = hydrated;
      changed = true;
      continue;
    }
    // Stub ids can embed replay-time turn context a partial range cannot
    // reproduce; the covering event still shares the same sequence.
    const stubIndex = timeline.findIndex(item => item.detailStub && item.sequence === entry.sequence);
    if (stubIndex >= 0) {
      timeline[stubIndex] = hydrated;
      changed = true;
      continue;
    }
    const sequence = entry.sequence ?? Number.MAX_SAFE_INTEGER;
    const position = timeline.findIndex(item => (item.sequence ?? 0) < sequence);
    if (position < 0) timeline.push(hydrated);
    else timeline.splice(position, 0, hydrated);
    changed = true;
  }
  // Placeholders whose covering events were fetched but project to no row are
  // resolved stubs, not failures; leaving them would pin the group loading.
  const nextTimeline = dropSupersededProgressEntries(timeline.filter(item =>
    !item.detailStub || item.sequence === undefined || !covered.has(item.sequence)));
  changed ||= nextTimeline.length !== timeline.length;
  if (!changed) return previous;
  return { ...previous, timeline: nextTimeline };
}

/** Row fields that describe how a projection built the row rather than what
 * it shows; an older projection must not copy them onto a newer row. */
const PROJECTION_FLAGS: ReadonlySet<string> = new Set(['detailStub', 'streamedText']);

/** Merge a row projected from an earlier history page into the loaded row of
 * the same id. Streamed text continues the earlier text; any other newer row
 * wins and only takes the fields it lacks from the older projection. */
function mergeEarlierEntry(older: TimelineEntry, newer: TimelineEntry): TimelineEntry {
  const firstSequence = older.firstSequence ?? newer.firstSequence;
  if (newer.streamedText) {
    const merged: TimelineEntry = { ...older, ...newer, subtitle: appendedSubtitle(older, newer), firstSequence };
    if (!older.streamedText) delete merged.streamedText;
    return merged;
  }
  const merged: Record<string, unknown> = { ...newer, firstSequence };
  for (const [key, value] of Object.entries(older)) {
    if (merged[key] === undefined && !PROJECTION_FLAGS.has(key)) merged[key] = value;
  }
  return merged as TimelineEntry;
}

const SEGMENT_SUFFIX = '#s';
function segmentStart(segmentId: string): number {
  return Number(segmentId.slice(segmentId.lastIndexOf(SEGMENT_SUFFIX) + SEGMENT_SUFFIX.length));
}

/** Merge an earlier history page under a lazily seeded runtime. Events must
 * lie below the loaded window; they project on a scratch runtime and only
 * their timeline rows merge in (timeline is newest-first), while turn state,
 * pending permissions, usage and extension UI keep reflecting the newest
 * events — replaying old events must not resurrect settled state. A row
 * spanning the floor merges with its older part by id, and the assistant
 * segment the window opened joins the segment still open at the page's end,
 * so paging in history yields the rows a full replay would. */
export function prependConversationRuntimeEvents(
  previous: ConversationRuntime,
  events: readonly ConversationEvent[],
): ConversationRuntime {
  const normalized = events
    .map(normalizeConversationEvent)
    .filter((event): event is ConversationEvent =>
      event !== null && event.conversationId === previous.conversationId)
    .sort((left, right) => left.sequence - right.sequence);
  if (!normalized.length) return previous;
  const scratch = projectScratchRuntime(previous, normalized);
  if (!scratch.timeline.length) return previous;
  const older = new Map(scratch.timeline.map((entry) => [entry.id, entry]));
  let timeline = previous.timeline;
  // A window that never touched the assistant stream still continues the
  // stream state the page ended with.
  const stream: Partial<ConversationRuntime> = previous.floorAssistantSegment === undefined
    ? { assistantSegmentStart: scratch.assistantSegmentStart, assistantStreamInterrupted: scratch.assistantStreamInterrupted }
    : {};
  const leading = previous.floorAssistantSegment;
  if (leading && scratch.assistantSegmentStart && !scratch.assistantStreamInterrupted) {
    const continued = `${leading.slice(0, leading.lastIndexOf(SEGMENT_SUFFIX))}${SEGMENT_SUFFIX}${scratch.assistantSegmentStart}`;
    if (continued !== leading && older.has(continued)) {
      timeline = timeline.map((entry) => entry.id === leading ? { ...entry, id: continued } : entry);
      if (previous.assistantSegmentStart === segmentStart(leading)) stream.assistantSegmentStart = scratch.assistantSegmentStart;
    }
  }
  stream.floorAssistantSegment = scratch.floorAssistantSegment === undefined ? leading : scratch.floorAssistantSegment;
  const loaded = new Set(timeline.map((entry) => entry.id));
  const merged = timeline.map((entry) => {
    const earlier = older.get(entry.id);
    return earlier ? mergeEarlierEntry(earlier, entry) : entry;
  });
  const appended = scratch.timeline.filter((entry) => !loaded.has(entry.id));
  return { ...previous, ...stream, timeline: dropSupersededProgressEntries([...merged, ...appended]) };
}

/** Adopt a still-running turn whose `turn.started` lies below a lazily loaded
 * window. Only the turn's own state (id, running status and the configuration
 * it started with) is taken from the start event; timeline rows, usage and
 * permissions below the window stay unloaded. A runtime that already tracks a
 * turn keeps it — a newer projection is never overridden by older history. */
export function adoptConversationRuntimeTurn(
  previous: ConversationRuntime,
  started: ConversationEvent,
): ConversationRuntime {
  const event = normalizeConversationEvent(started);
  if (!event || event.conversationId !== previous.conversationId || previous.activeTurnId
    || canonicalConversationEventType(event) !== 'turn.started') return previous;
  const scratch = projectScratchRuntime(previous, [event]);
  if (!scratch.activeTurnId) return previous;
  return {
    ...previous,
    activeTurnId: scratch.activeTurnId,
    status: previous.pendingPermissions.some(item => item.scope !== 'session'
      && (!item.turnId || item.turnId === scratch.activeTurnId)) ? 'waitingPermission' : scratch.status,
    requestedConfig: scratch.requestedConfig,
    effectiveConfig: scratch.effectiveConfig,
    configurationStatus: scratch.configurationStatus,
  };
}
