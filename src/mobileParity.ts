/**
 * Pure protocol/session helpers shared by the mobile client.
 *
 * This module deliberately has type-only imports.  It can therefore be
 * re-exported by the legacy protocol module without introducing a runtime
 * dependency cycle in the React Native bundle.
 */
import type {
  BackendConnectionProfile,
  ConnectionSettings,
  LocalAdapterState,
} from './todex';
import type {
  AgentEventEnvelope,
  ConversationEvent,
  ConversationManifest,
  ExtensionCustomMessage,
  ProviderKind,
} from './v2';
import { canonicalConversationEventType, normalizeConversationEvent, toAgentEventEnvelope } from './v2';

type JsonRecord = Record<string, unknown>;

const DEFAULT_SERVER_URL = 'http://127.0.0.1:7345';
const DEFAULT_CONVERSATION_TITLE = '新对话';
const DEFAULT_MAX_USAGE_RECORDS = 2_000;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function readString(record: JsonRecord | null | undefined, keys: string[]): string {
  if (!record) {
    return '';
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function readBoolean(record: JsonRecord | null | undefined, keys: string[], fallback = false): boolean {
  if (!record) {
    return fallback;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (/^(true|yes|1)$/i.test(value.trim())) return true;
      if (/^(false|no|0)$/i.test(value.trim())) return false;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value !== 0;
    }
  }
  return fallback;
}

function readNumber(record: JsonRecord | null | undefined, keys: string[], fallback = 0): number {
  if (!record) {
    return fallback;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function resolveNow(value: number | { now?: number } | undefined, fallback = Date.now()): number {
  if (typeof value === 'number') {
    return finiteOr(value, fallback);
  }
  return value && typeof value.now === 'number' && Number.isFinite(value.now)
    ? value.now
    : fallback;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (/^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeProfileServerUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return DEFAULT_SERVER_URL;
  }

  let candidate = value;
  if (!/^https?:\/\//i.test(candidate) && !/^wss?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  candidate = candidate
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://');

  try {
    const parsed = new URL(candidate);
    const normalizedHostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const hostname = ['localhost', '::1', '0:0:0:0:0:0:0:1'].includes(normalizedHostname.toLowerCase())
      ? '127.0.0.1'
      : normalizedHostname;
    const protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const origin = parsed.port
      ? `${protocol}//${host}:${parsed.port}`
      : `${protocol}//${host}`;
    return origin.replace(/\/+$/, '');
  } catch {
    return candidate.replace(/\/+$/, '');
  }
}

/** Normalize the aliases accepted by the desktop model selector. */
export function normalizeConversationReasoningEffort(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, '') ?? '';
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case 'none':
    case 'off':
      return 'none';
    case 'minimal':
    case 'min':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
    case 'med':
    case 'default':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'extra':
    case 'extrahigh':
    case 'max':
      return 'xhigh';
    default:
      return null;
  }
}

function normalizeEncryptionProtocol(value: unknown): ConnectionSettings['encryptionProtocol'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'x25519') return 'x25519';
  if (normalized === 'ml-kem-768' || normalized === 'mlkem768' || normalized === 'ml_kem_768') {
    return 'ml-kem-768';
  }
  return 'none';
}

export type BackendProfileNormalizeOptions = {
  now?: number;
};

/** Normalize a persisted backend profile, including legacy snake_case fields. */
export function normalizeBackendConnectionProfile(
  value: unknown,
  options: BackendProfileNormalizeOptions | number = {},
): BackendConnectionProfile | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const id = readString(raw, ['id', 'profileId', 'profile_id']);
  const serverUrl = readString(raw, ['serverUrl', 'server_url', 'url', 'endpoint']);
  if (!id || !serverUrl) {
    return null;
  }
  const now = resolveNow(options);
  const createdAt = parseTimestamp(raw.createdAt ?? raw.created_at, now);
  const updatedAt = parseTimestamp(raw.updatedAt ?? raw.updated_at, createdAt);
  return {
    id,
    name: readString(raw, ['name', 'displayName', 'display_name']) || '后端',
    serverUrl: normalizeProfileServerUrl(serverUrl),
    authToken: typeof raw.authToken === 'string'
      ? raw.authToken
      : typeof raw.auth_token === 'string' ? raw.auth_token : '',
    deviceSecret: typeof raw.deviceSecret === 'string'
      ? raw.deviceSecret
      : typeof raw.device_secret === 'string' ? raw.device_secret : '',
    tenantId: readString(raw, ['tenantId', 'tenant_id']) || 'local',
    encryptionProtocol: normalizeEncryptionProtocol(raw.encryptionProtocol ?? raw.encryption_protocol),
    encryptionPublicKey: typeof raw.encryptionPublicKey === 'string'
      ? raw.encryptionPublicKey
      : typeof raw.encryption_public_key === 'string' ? raw.encryption_public_key : '',
    createdAt,
    updatedAt,
  };
}

export function normalizeBackendConnectionProfiles(
  value: unknown,
  options: BackendProfileNormalizeOptions | number = {},
): BackendConnectionProfile[] {
  const root = asRecord(value);
  const items = Array.isArray(value)
    ? value
    : (root && (Array.isArray(root.profiles) ? root.profiles : Array.isArray(root.connections) ? root.connections : [])) ?? [];
  const seen = new Set<string>();
  const profiles: BackendConnectionProfile[] = [];
  for (const item of items) {
    const profile = normalizeBackendConnectionProfile(item, options);
    if (!profile || seen.has(profile.id)) {
      continue;
    }
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

export function profileFromSettings(
  settings: ConnectionSettings,
  name = '默认后端',
  id = 'default-backend',
  now = Date.now(),
): BackendConnectionProfile {
  const timestamp = finiteOr(now, Date.now());
  return {
    id: id.trim() || 'default-backend',
    name: name.trim() || '默认后端',
    serverUrl: normalizeProfileServerUrl(settings.serverUrl),
    authToken: settings.authToken,
    deviceSecret: settings.deviceSecret,
    tenantId: settings.tenantId,
    encryptionProtocol: normalizeEncryptionProtocol(settings.encryptionProtocol),
    encryptionPublicKey: settings.encryptionPublicKey,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function settingsFromProfile(
  profile: BackendConnectionProfile,
  current: ConnectionSettings,
): ConnectionSettings {
  const normalized = normalizeBackendConnectionProfile(profile);
  if (!normalized) {
    return current;
  }
  return {
    ...current,
    serverUrl: normalized.serverUrl,
    authToken: normalized.authToken,
    deviceSecret: normalized.deviceSecret,
    tenantId: normalized.tenantId,
    encryptionProtocol: normalized.encryptionProtocol,
    encryptionPublicKey: normalized.encryptionPublicKey,
  };
}

export type ConversationRecord = {
  id: string;
  workspaceId: string;
  backendConnectionId?: string | null;
  title: string;
  preview?: string;
  nativeStatus?: string;
  archived?: boolean;
  sessionId: string;
  threadId: string;
  localAdapterState?: LocalAdapterState;
  mode?: 'plan' | 'implement';
  goalStatus?: string;
  goalObjective?: string;
  provider?: ProviderKind | string;
  providerProfile?: string;
  model?: string;
  reasoningEffort?: string | null;
  v2ConversationId?: string;
  lastSequence?: number;
  createdAt: number;
  updatedAt: number;
};

export type ConversationNormalizeOptions = {
  now?: number;
  fallbackWorkspaceId?: string;
  fallbackProvider?: ProviderKind | string;
  fallbackModel?: string;
  backendConnectionId?: string | null;
};

function normalizeLocalAdapterState(value: string): LocalAdapterState | undefined {
  switch (value.trim().toLowerCase()) {
    case 'idle':
    case 'starting':
    case 'running':
    case 'stopped':
    case 'error':
      return value.trim().toLowerCase() as LocalAdapterState;
    default:
      return undefined;
  }
}

function providerLabel(provider: string): string {
  const id = provider.trim().toLowerCase();
  if (id === 'codex' || id.includes('codex')) return 'Codex CLI';
  if (id === 'claude-code' || id.includes('claude')) return 'Claude Code';
  if (id === 'pi' || id.startsWith('pi-')) return 'Pi';
  if (id === 'acp') return 'ACP';
  if (id === 'grok-build' || id === 'grok') return 'Grok Build';
  if (id === 'devin' || id === 'devin-cli' || id === 'devin_cli') return 'Devin';
  if (id === 'opencode' || id === 'open-code' || id === 'open_code') return 'OpenCode';
  return provider.trim() || 'Agent';
}

/** Normalize local/remote conversation rows into one mobile-safe shape. */
export function normalizeConversationRecord(
  value: unknown,
  options: ConversationNormalizeOptions = {},
): ConversationRecord | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const explicitV2Id = readString(raw, ['v2ConversationId', 'v2_conversation_id']);
  const id = readString(raw, ['id', 'conversationId', 'conversation_id']) || explicitV2Id;
  const workspaceId = readString(raw, ['workspaceId', 'workspace_id', 'workspace'])
    || options.fallbackWorkspaceId?.trim()
    || '';
  if (!id || !workspaceId) {
    return null;
  }

  const provider = readString(raw, ['provider', 'providerKind', 'provider_kind', 'agentProvider'])
    || (typeof options.fallbackProvider === 'string' ? options.fallbackProvider.trim() : '');
  const hasManifestShape = Boolean(provider)
    && (Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')
      || Object.prototype.hasOwnProperty.call(raw, 'lastSequence')
      || Object.prototype.hasOwnProperty.call(raw, 'status'));
  const v2ConversationId = explicitV2Id || (hasManifestShape ? id : '');
  const now = resolveNow(options);
  const createdAt = parseTimestamp(raw.createdAt ?? raw.created_at, now);
  const updatedAt = parseTimestamp(raw.updatedAt ?? raw.updated_at, createdAt);
  const model = readString(raw, ['model', 'modelId', 'model_id']) || options.fallbackModel?.trim() || '';
  const rawReasoning = readString(raw, ['reasoningEffort', 'reasoning_effort', 'reasoningLevel', 'reasoning_level']);
  const sequence = readNumber(raw, ['lastSequence', 'last_sequence', 'sequence'], Number.NaN);
  const backendConnectionId = readString(raw, ['backendConnectionId', 'backend_connection_id'])
    || options.backendConnectionId
    || null;
  const modeValue = readString(raw, ['mode']).toLowerCase();
  const mode = modeValue === 'plan' || modeValue === 'implement' ? modeValue : 'implement';

  return {
    id,
    workspaceId,
    backendConnectionId,
    title: readString(raw, ['title', 'name']) || (provider ? providerLabel(provider) : DEFAULT_CONVERSATION_TITLE),
    preview: readString(raw, ['preview', 'summary', 'firstMessage', 'first_message']),
    nativeStatus: readString(raw, ['nativeStatus', 'native_status', 'status']) || undefined,
    archived: readBoolean(raw, ['archived', 'isArchived', 'is_archived'], false),
    sessionId: readString(raw, ['sessionId', 'session_id']) || (v2ConversationId ? `v2_${v2ConversationId}` : `conversation_${id}`),
    threadId: readString(raw, ['threadId', 'thread_id']),
    localAdapterState: normalizeLocalAdapterState(readString(raw, ['localAdapterState', 'local_adapter_state'])) || 'idle',
    mode,
    goalStatus: readString(raw, ['goalStatus', 'goal_status']),
    goalObjective: readString(raw, ['goalObjective', 'goal_objective', 'objective']),
    provider: provider || undefined,
    providerProfile: readString(raw, ['providerProfile', 'provider_profile']) || undefined,
    model: model || undefined,
    reasoningEffort: normalizeConversationReasoningEffort(rawReasoning),
    v2ConversationId: v2ConversationId || undefined,
    lastSequence: Number.isFinite(sequence) ? sequence : undefined,
    createdAt,
    updatedAt,
  };
}

export type ConversationManifestNormalizeOptions = ConversationNormalizeOptions;

export function conversationFromManifest(
  manifest: ConversationManifest,
  workspaceId: string,
  options: ConversationManifestNormalizeOptions = {},
): ConversationRecord {
  const normalized = normalizeConversationRecord({
    ...manifest,
    workspaceId,
    v2ConversationId: manifest.id,
    sessionId: `v2_${manifest.id}`,
  }, {
    ...options,
    fallbackWorkspaceId: workspaceId,
    fallbackProvider: manifest.provider,
  });
  // A typed manifest always contains an id and workspace id; keep a defensive
  // fallback for data crossing the native bridge at runtime.
  if (normalized) {
    return normalized;
  }
  const now = resolveNow(options);
  return {
    id: manifest.id,
    workspaceId,
    title: manifest.title || providerLabel(manifest.provider),
    preview: '',
    nativeStatus: manifest.status,
    archived: false,
    sessionId: `v2_${manifest.id}`,
    threadId: '',
    localAdapterState: 'idle',
    mode: 'implement',
    goalStatus: '',
    goalObjective: '',
    provider: manifest.provider,
    providerProfile: manifest.providerProfile,
    v2ConversationId: manifest.id,
    lastSequence: manifest.lastSequence,
    createdAt: parseTimestamp(manifest.createdAt, now),
    updatedAt: parseTimestamp(manifest.updatedAt, now),
  };
}

export type ConversationContextUsage = {
  usedTokens: number;
  contextWindow?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  model?: string;
  updatedAt: number;
};

export type UsageRecord = {
  turnId?: string;
  sequence?: number;
  scope?: 'request' | 'turn' | 'session' | 'unknown';
  totalTokens?: number;
  cacheSemantics?: 'included' | 'additional' | 'unknown';
  id: string;
  conversationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  updatedAt: number;
};

export type UsageNormalizeOptions = {
  now?: number;
  limit?: number;
};

export const MAX_USAGE_RECORDS = DEFAULT_MAX_USAGE_RECORDS;

export function usageNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function usageField(record: JsonRecord | null, keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    if (record[key] !== undefined) {
      return usageNumber(record[key]);
    }
  }
  return 0;
}

export function normalizeUsageRecords(
  value: unknown,
  options: UsageNormalizeOptions | number = {},
): UsageRecord[] {
  const root = asRecord(value);
  const items = Array.isArray(value)
    ? value
    : (root && (Array.isArray(root.records) ? root.records : Array.isArray(root.usage) ? root.usage : Array.isArray(root.items) ? root.items : [])) ?? [];
  const now = resolveNow(options);
  const limit = typeof options === 'object' && typeof options.limit === 'number' && options.limit >= 0
    ? Math.floor(options.limit)
    : DEFAULT_MAX_USAGE_RECORDS;
  if (limit === 0) {
    return [];
  }
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const item of items) {
    const raw = asRecord(item);
    if (!raw) continue;
    const id = readString(raw, ['id', 'usageId', 'usage_id']);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const updatedAt = parseTimestamp(raw.updatedAt ?? raw.updated_at, now);
    records.push({
      id,
      conversationId: readString(raw, ['conversationId', 'conversation_id']),
      provider: readString(raw, ['provider']) || 'unknown',
      model: readString(raw, ['model', 'modelId', 'model_id']) || 'unknown',
      inputTokens: usageField(raw, ['inputTokens', 'input_tokens', 'input']),
      outputTokens: usageField(raw, ['outputTokens', 'output_tokens', 'output']),
      cachedInputTokens: usageField(raw, ['cachedInputTokens', 'cached_input_tokens', 'cacheRead', 'cache_read', 'cacheReadInputTokens', 'cache_read_input_tokens']),
      cacheWriteTokens: usageField(raw, ['cacheWriteTokens', 'cache_write_tokens', 'cacheWrite', 'cache_write', 'cacheCreationInputTokens', 'cache_creation_input_tokens']),
      updatedAt,
      ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
      ...(typeof raw.sequence === 'number' ? { sequence: raw.sequence } : {}),
      ...(typeof raw.totalTokens === 'number' ? { totalTokens: usageNumber(raw.totalTokens) } : {}),
      ...(['request', 'turn', 'session', 'unknown'].includes(String(raw.scope)) ? { scope: raw.scope as UsageRecord['scope'] } : {}),
      ...(['included', 'additional', 'unknown'].includes(String(raw.cacheSemantics)) ? { cacheSemantics: raw.cacheSemantics as UsageRecord['cacheSemantics'] } : {}),
    });
    if (records.length >= limit) break;
  }
  return records;
}

function objectAt(record: JsonRecord | null, keys: string[]): JsonRecord | null {
  if (!record) return null;
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function eventTime(event: ConversationEvent | JsonRecord, fallback: number): number {
  const raw = asRecord(event);
  return parseTimestamp(raw?.time ?? raw?.timestamp, fallback);
}

/** Extract usage snapshots emitted by Codex tokenUsage or provider messages. */
export function contextUsageFromV2Event(
  event: ConversationEvent,
  now = Date.now(),
): ConversationContextUsage | null {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord?.payload);
  if (!eventRecord || !payload) return null;
  const metadata = objectAt(payload, ['metadata', 'meta']);
  const tokenUsage = objectAt(metadata, ['tokenUsage', 'token_usage'])
    || objectAt(payload, ['tokenUsage', 'token_usage']);
  const last = objectAt(tokenUsage, ['last', 'latest', 'current']);
  const providerMethod = readString(payload, ['providerMethod', 'provider_method', 'method'])
    || readString(eventRecord, ['providerMethod', 'provider_method']);
  const eventType = readString(eventRecord, ['type', 'eventType', 'event_type']);
  const normalizedUsage = objectAt(payload, ['usage']);
  const normalizedLast = objectAt(normalizedUsage, ['last']);
  const normalizedBlock = conversationBlock(payload, '');
  if ((eventType === 'usage.updated' || normalizedBlock?.category === 'usage') && normalizedLast) {
    const inputTokens = usageField(normalizedLast, ['input']);
    const outputTokens = usageField(normalizedLast, ['output']);
    const cachedInputTokens = usageField(normalizedLast, ['cacheRead']);
    const cacheWriteTokens = usageField(normalizedLast, ['cacheWrite']);
    const total = usageField(normalizedLast, ['total']);
    const model = readString(payload, ['model', 'modelId', 'model_id']);
    return {
      usedTokens: total || inputTokens + outputTokens,
      contextWindow: usageField(payload, ['contextWindow', 'context_window']) || undefined,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      ...(model ? { model } : {}),
      updatedAt: eventTime(event, now),
    };
  }
  if (last && (providerMethod === 'thread/tokenUsage/updated' || /tokenusage[./:_-]*updated/i.test(eventType))) {
    const inputTokens = usageField(last, ['inputTokens', 'input_tokens', 'input']);
    const outputTokens = usageField(last, ['outputTokens', 'output_tokens', 'output']);
    const cachedInputTokens = usageField(last, ['cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cacheRead']);
    const cacheWriteTokens = usageField(last, ['cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cacheWrite']);
    const total = usageField(last, ['totalTokens', 'total_tokens', 'total']);
    const model = readString(payload, ['model', 'modelId', 'model_id']);
    return {
      usedTokens: total || inputTokens + outputTokens,
      contextWindow: usageField(tokenUsage, ['modelContextWindow', 'model_context_window', 'contextWindow', 'context_window']) || undefined,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      ...(model ? { model } : {}),
      updatedAt: eventTime(event, now),
    };
  }

  const message = objectAt(payload, ['message']);
  const usage = objectAt(message, ['usage']) || objectAt(payload, ['usage']);
  const role = readString(message, ['role']) || readString(payload, ['role']);
  const flatUsageUpdate = eventType === 'usage.updated' && normalizedUsage
    && ['input', 'inputTokens', 'input_tokens', 'output', 'outputTokens', 'output_tokens'].some(key => normalizedUsage[key] !== undefined);
  if (!usage || (!flatUsageUpdate && (eventType !== 'message.completed' || role.toLowerCase() !== 'assistant'))) {
    return null;
  }
  const inputTokens = usageField(usage, ['input', 'inputTokens', 'input_tokens']);
  const outputTokens = usageField(usage, ['output', 'outputTokens', 'output_tokens']);
  const cachedInputTokens = usageField(usage, ['cacheRead', 'cache_read', 'cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens']);
  const cacheWriteTokens = usageField(usage, ['cacheWrite', 'cache_write', 'cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens']);
  const total = usageField(usage, ['totalTokens', 'total_tokens', 'total']);
  return {
    usedTokens: total || inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    model: readString(message, ['model', 'modelId', 'model_id']) || readString(payload, ['model', 'modelId', 'model_id']) || undefined,
    updatedAt: eventTime(event, now),
  };
}

export type UsageRecordContext = {
  conversationId?: string;
  provider?: string;
  model?: string;
};

export function usageRecordFromV2Event(
  event: ConversationEvent,
  context: UsageRecordContext = {},
  now = Date.now(),
): UsageRecord | null {
  const usage = contextUsageFromV2Event(event, now);
  if (!usage) return null;
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord?.payload);
  const conversationId = context.conversationId?.trim() || readString(eventRecord, ['conversationId', 'conversation_id']);
  if (!conversationId) return null;
  const eventId = readString(eventRecord, ['eventId', 'event_id', 'id']) || `sequence-${readNumber(eventRecord, ['sequence'], 0)}`;
  return {
    id: `${conversationId}:${eventId}`,
    conversationId,
    provider: context.provider?.trim() || readString(payload, ['provider']) || 'unknown',
    model: context.model?.trim() || usage.model || readString(payload, ['model', 'modelId', 'model_id']) || 'unknown',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    updatedAt: usage.updatedAt,
  };
}

export const usageRecordFromEvent = usageRecordFromV2Event;

export type ConversationBlockCategory =
  | 'assistant_final'
  | 'assistant_progress'
  | 'reasoning'
  | 'tool'
  | 'approval'
  | 'status'
  | 'error'
  | 'usage'
  | 'extension';

export type ConversationBlockPhase = 'started' | 'delta' | 'completed' | 'failed';

export type TimelineEntry = {
  id: string;
  kind: 'incoming' | 'outgoing' | 'system';
  title: string;
  subtitle: string;
  raw: string;
  at: number;
  workspaceId?: string;
  conversationId?: string;
  requestId?: string;
  category?: ConversationBlockCategory;
  phase?: ConversationBlockPhase;
  turnId?: string;
  blockId?: string;
  contentIndex?: number;
  /** Sequence of the newest event merged into this row. */
  sequence?: number;
  /** Sequence of the event that created this row; with `sequence` it bounds
   * the journal range a folded row was built from. */
  firstSequence?: number;
  /** Placeholder for a `detail=summary` replay event: content loads on expand. */
  detailStub?: boolean;
  /** Progress block ids a final answer was streamed under (`block.supersedes`). */
  supersedes?: string[];
  /** The subtitle holds only streamed deltas, so text projected from earlier
   * history for the same row precedes it instead of being replaced. */
  streamedText?: boolean;
  extensionMessage?: ExtensionCustomMessage & { runtimeId: string; messageId: string };
};

type NormalizedConversationBlock = {
  category: ConversationBlockCategory;
  id: string;
  phase: ConversationBlockPhase;
  turnId: string;
  contentIndex?: number;
  supersedes?: string[];
};

const BLOCK_CATEGORIES = new Set<ConversationBlockCategory>([
  'assistant_final', 'assistant_progress', 'reasoning', 'tool',
  'approval', 'status', 'error', 'usage',
]);
const BLOCK_PHASES = new Set<ConversationBlockPhase>(['started', 'delta', 'completed', 'failed']);

function conversationBlock(payload: JsonRecord, fallbackTurnId: string): NormalizedConversationBlock | null {
  const block = asRecord(payload.block);
  const category = readString(block, ['category']) as ConversationBlockCategory;
  const phase = readString(block, ['phase']) as ConversationBlockPhase;
  const id = readString(block, ['id']);
  if (!id || !BLOCK_CATEGORIES.has(category) || !BLOCK_PHASES.has(phase)) return null;
  const contentIndex = readNumber(block, ['contentIndex', 'content_index'], -1);
  const rawSupersedes = block?.supersedes;
  const supersedes = Array.isArray(rawSupersedes)
    ? rawSupersedes.filter((value): value is string => typeof value === 'string' && value !== '')
    : [];
  return {
    category,
    id,
    phase,
    turnId: readString(block, ['turnId', 'turn_id']) || fallbackTurnId,
    ...(contentIndex >= 0 ? { contentIndex } : {}),
    ...(supersedes.length ? { supersedes } : {}),
  };
}

function shortJsonValue(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : String(value);
  } catch {
    return String(value);
  }
}

const EVENT_PREVIEW_CHARS = 220;
const FAILURE_MESSAGE_CHARS = 4000;

/** Bounded previews must mark the cut instead of clipping text mid-word. */
function previewText(text: string, limit = EVENT_PREVIEW_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function textFromUnknown(value: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => textFromUnknown(item, depth + 1)).filter(Boolean).join('');
  }
  const record = asRecord(value);
  if (!record) return '';
  for (const key of ['text', 'content', 'thinking', 'reasoning', 'analysis', 'delta', 'output_text', 'outputText', 'summary', 'message', 'partialResult', 'partial_result', 'result']) {
    const text = textFromUnknown(record[key], depth + 1);
    if (text) return text;
  }
  return '';
}

/** Answer text for untyped message events. A full message envelope (Claude
 * sends one per content block) contributes only its text parts, so thinking
 * and tool_use blocks never become answer bubbles. */
function assistantContent(payload: JsonRecord, message: JsonRecord | null, delta: JsonRecord | null): string {
  const candidates: unknown[] = [
    payload.content,
    payload.text,
    typeof payload.delta === 'string' ? payload.delta : undefined,
    delta?.text,
    delta?.delta,
    delta?.content,
    delta?.output_text,
  ];
  for (const candidate of candidates) {
    const text = textFromUnknown(candidate);
    if (text) return text;
  }
  if (typeof payload.message === 'string') return payload.message;
  const text = textFromUnknown(message?.text);
  if (text || !Array.isArray(message?.content)) return text || textFromUnknown(message?.content);
  // Whitespace inside text parts is significant, so parts are read unclipped.
  return message.content.map((part) => {
    const type = readString(asRecord(part), ['type']).toLowerCase();
    return type && !['text', 'output_text', 'input_text'].includes(type) ? '' : textFromUnknown(part);
  }).join('');
}

function conversationContent(payload: JsonRecord, message: JsonRecord | null, delta: JsonRecord | null): string {
  const candidates: unknown[] = [
    payload.content,
    payload.text,
    typeof payload.delta === 'string' ? payload.delta : undefined,
    delta?.text,
    delta?.delta,
    delta?.content,
    delta?.thinking,
    delta?.reasoning,
    delta?.output_text,
    payload.message,
    message?.content,
  ];
  for (const candidate of candidates) {
    const text = textFromUnknown(candidate);
    if (text) return text;
  }
  return '';
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    const record = asRecord(part);
    if (!record) return '';
    const type = readString(record, ['type']).toLowerCase();
    if (type && !['text', 'output_text', 'input_text'].includes(type)) return '';
    return readString(record, ['text', 'content', 'output_text', 'outputText']);
  }).filter(Boolean).join('');
}

// Text deltas can consist entirely of whitespace. Identifier trimming must never
// alter content or streamed JSON fragments.
function readContentString(record: JsonRecord | null | undefined, keys: string[]): string {
  if (!record) return '';
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  return '';
}

function blockContent(
  category: ConversationBlockCategory,
  payload: JsonRecord,
  message: JsonRecord | null,
  delta: JsonRecord | null,
): string {
  if (category === 'assistant_final' || category === 'assistant_progress') {
    return readContentString(payload, ['text', 'content'])
      || (typeof payload.delta === 'string' ? payload.delta : '')
      || readContentString(delta, ['text', 'delta', 'content'])
      || textContent(message?.content)
      || readContentString(message, ['text']);
  }
  if (category === 'reasoning') {
    return readContentString(payload, ['thought', 'thoughtText', 'thought_text', 'reasoning', 'thinking', 'analysis'])
      || readContentString(delta, ['thinking', 'reasoning', 'analysis', 'text', 'delta', 'content']);
  }
  if (category === 'tool') {
    const toolCall = asRecord(delta?.toolCall) || asRecord(payload.toolCall) || asRecord(payload.tool_call);
    const toolCallId = readContentString(payload, ['toolCallId', 'tool_call_id', 'callId', 'call_id']) || readContentString(toolCall, ['id', 'toolCallId', 'tool_call_id']);
    if (toolCallId || toolCall) {
      return shortJsonValue({
        toolName: payload.toolName ?? payload.tool_name ?? toolCall?.toolName ?? toolCall?.name ?? toolCall?.tool_name,
        arguments: payload.arguments ?? payload.input ?? toolCall?.arguments ?? toolCall?.input,
        partialResult: payload.partialResult ?? payload.partial_result,
        result: payload.result,
        isError: payload.isError ?? payload.is_error,
      });
    }
    const deltaText = readContentString(delta, ['delta']);
    if (deltaText) return deltaText;
    const value = payload.partialResult ?? payload.partial_result ?? payload.result
      ?? payload.arguments ?? payload.item ?? payload.tool ?? payload.toolCall ?? payload.tool_call
      ?? toolCall ?? delta;
    return typeof value === 'string' ? value : shortJsonValue(value);
  }
  if (category === 'approval') {
    return readContentString(payload, ['title', 'question', 'message'])
      || (payload.details === undefined ? '' : shortJsonValue(payload.details));
  }
  if (category === 'error') {
    return readContentString(payload, ['message', 'error', 'reason']) || shortJsonValue(payload.error ?? payload);
  }
  if (category === 'status') {
    return readContentString(payload, ['status', 'message', 'text']);
  }
  return '';
}

function normalizeEventType(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isProviderLifecycleMethod(value: string): boolean {
  return /(?:^|[\/._-])mcp(?:[\/._-])(?:initialized|server(?:[\/._-])?status)$/i.test(value);
}

export function shouldAppendV2ConversationEvent(event: ConversationEvent): boolean {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord?.payload);
  const delta = asRecord(payload?.delta);
  const type = canonicalConversationEventType(event);
  const deltaType = readString(delta, ['type', 'deltaType', 'delta_type']);
  const block = payload ? conversationBlock(payload, '') : null;
  // Tool blocks are structured snapshots ({toolName, arguments, result});
  // appending them would corrupt the JSON subtitle instead of streaming text.
  if (block) return block.phase === 'delta' && block.category !== 'tool';
  return type === 'assistant.delta'
    || type === 'reasoning.delta'
    || type === 'message.delta'
    || type === 'thought.delta'
    || /(?:thinking|text|toolcall)_delta$/i.test(deltaType);
}

export type ConversationReplayState = {
  timeline: TimelineEntry[];
  activeTurnId: string;
  lastSequence: number;
  missingSequences: number[];
  normalizedEvents: AgentEventEnvelope[];
};

/** Reduce live and replayed events through one idempotent, gap-aware path. */
export function reduceConversationEvents(
  events: ConversationEvent[],
  workspaceId: string,
): ConversationReplayState {
  const timeline: TimelineEntry[] = [];
  const seen = new Set<string>();
  const missingSequences: number[] = [];
  const replayEnvelopes: AgentEventEnvelope[] = [];
  let activeTurnId = '';
  let lastSequence = 0;
  const normalizedEvents = events.map(normalizeConversationEvent).filter((event): event is ConversationEvent => event !== null);
  let assistantSegmentStart = 0;
  let assistantStreamInterrupted = false;
  for (const event of normalizedEvents.sort((a, b) => a.sequence - b.sequence)) {
    const key = event.eventId || `${event.conversationId}:${event.sequence}:${event.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    replayEnvelopes.push(toAgentEventEnvelope(event));
    if (event.sequence > lastSequence + 1) {
      const end = Math.min(event.sequence, lastSequence + 10_001);
      for (let sequence = lastSequence + 1; sequence < end; sequence += 1) missingSequences.push(sequence);
    }
    const payload = asRecord(event.payload) || {};
    const turnId = readString(payload, ['turnId', 'turn_id']);
    const type = canonicalConversationEventType(event);
    if (type === 'turn.started' && turnId) {
      activeTurnId = turnId;
      assistantSegmentStart = 0;
      assistantStreamInterrupted = false;
    }
    const classifiedEntry = classifyV2ConversationEvent(event, workspaceId, turnId || activeTurnId);
    // Same segmentation as the live runtime: activity between two chunks of
    // the shared assistant stream starts a new entry named by the sequence of
    // its first chunk (see projectEvent).
    if (classifiedEntry && classifiedEntry.kind !== 'incoming') {
      assistantStreamInterrupted = true;
    }
    let segmentedId: string | undefined;
    if (classifiedEntry && classifiedEntry.kind === 'incoming' && classifiedEntry.id.startsWith('v2-assistant-')) {
      if (assistantStreamInterrupted || !assistantSegmentStart) {
        assistantSegmentStart = event.sequence;
        assistantStreamInterrupted = false;
      }
      segmentedId = `${classifiedEntry.id}#s${assistantSegmentStart}`;
    }
    const entry = classifiedEntry && segmentedId ? { ...classifiedEntry, id: segmentedId } : classifiedEntry;
    if (entry) {
      const index = timeline.findIndex((item) => item.id === entry.id);
      if (index < 0) timeline.unshift({ ...entry, firstSequence: event.sequence });
      else {
        const previous = timeline[index];
        timeline[index] = { ...previous, ...entry, firstSequence: previous.firstSequence,
          subtitle: shouldAppendV2ConversationEvent(event)
            ? `${previous.subtitle === '正在回复...' ? '' : previous.subtitle}${entry.subtitle}`
            : entry.subtitle };
      }
    }
    if (['turn.completed', 'turn.cancelled', 'turn.interrupted', 'turn.failed'].includes(type) && (!turnId || turnId === activeTurnId)) activeTurnId = '';
    lastSequence = Math.max(lastSequence, event.sequence);
  }
  return { timeline, activeTurnId, lastSequence, missingSequences, normalizedEvents: replayEnvelopes };
}

/** Convert a v2 event into a render-neutral timeline entry. */
/** Journal placeholder for a record the backend could not read back. */
const JOURNAL_RECORD_LOST = 'journal.recordLost';

export function classifyV2ConversationEvent(
  event: ConversationEvent,
  workspaceId: string,
  activeTurnId = '',
  now = Date.now(),
): TimelineEntry | null {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord?.payload) || {};
  const message = asRecord(payload.message);
  const delta = asRecord(payload.delta);
  const type = canonicalConversationEventType(event);
  const eventId = readString(eventRecord, ['eventId', 'event_id', 'id']) || `sequence-${readNumber(eventRecord, ['sequence'], 0)}`;
  const conversationId = readString(eventRecord, ['conversationId', 'conversation_id']);
  const content = conversationContent(payload, message, delta);
  const role = (readString(payload, ['role']) || readString(message, ['role'])).toLowerCase();
  const turnId = payload.scope === 'session' ? '' : readString(payload, ['turnId', 'turn_id']) || activeTurnId;
  const deltaType = readString(delta, ['type', 'deltaType', 'delta_type']);
  const contentIndex = readNumber(delta, ['contentIndex', 'content_index'], -1);
  const streamId = turnId || (contentIndex >= 0 ? `content-${contentIndex}` : 'current');
  const providerMethod = readString(payload, ['providerMethod', 'provider_method', 'method']);
  const messageRole = readString(message, ['role']).toLowerCase();
  const at = eventTime(event, now);
  const base = { raw: '', at, workspaceId, conversationId, turnId, sequence: event.sequence };
  const block = conversationBlock(payload, turnId);

  if (type === 'extension.message') {
    if (!message || message.role !== 'custom' || message.display === false) return null;
    const runtimeId = readString(payload, ['runtimeId']);
    const messageId = readString(payload, ['messageId']) || eventId;
    const customType = readString(message, ['customType']) || 'custom';
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.flatMap(item => {
        const part = asRecord(item);
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
      }).join('\n') : '';
    return {
      ...base,
      id: `v2-extension-${conversationId}-${runtimeId}-${messageId}`,
      kind: 'system', category: 'extension', phase: 'completed', title: customType,
      subtitle: text || '此插件消息包含非文本内容。',
      extensionMessage: { role: 'custom', customType, content: message.content,
        display: true, runtimeId, messageId,
        ...(message.details !== undefined ? { details: message.details } : {}),
        ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}) },
    };
  }

  if (type === 'provider.event' && isProviderLifecycleMethod(providerMethod)) {
    return null;
  }

  // The backend replaces corrupt journal records with placeholders; one
  // notice stands for each run of consecutive ones, which share `runStart`.
  if (type === JOURNAL_RECORD_LOST || event.type === JOURNAL_RECORD_LOST) {
    const runStart = readNumber(payload, ['runStart'], event.sequence);
    const runLength = Math.max(1, Math.floor(readNumber(payload, ['runLength'], 1)));
    return {
      id: `v2-record-lost-${conversationId}-${runStart}`,
      kind: 'system',
      title: '记录损坏',
      subtitle: `${runLength} 条记录损坏，已跳过`,
      ...base,
    };
  }

  // Provider-internal chatter never renders: command catalog broadcasts are a
  // data event, and ACP `_`-prefixed methods are implementation-private
  // extensions (Devin streams MCP logs and thinking markers there). Tool-call
  // notifications stay visible even when they arrive on a private channel.
  if (type === 'provider.commands.updated'
    || (type === 'provider.event' && providerMethod.startsWith('_')
      && !/tool|command|function/i.test(providerMethod))) {
    return null;
  }

  if (type === 'message.created' && (role === 'user' || role === 'human')) {
    return { id: eventId, kind: 'outgoing', title: 'You', subtitle: content, ...base };
  }
  if (type === 'message.completed' && (role === 'user' || role === 'human')) {
    return null;
  }
  if (
    type === 'message.completed'
    && (
      readString(message, ['stopReason', 'stop_reason']) === 'toolUse'
      || (messageRole && messageRole !== 'assistant')
    )
  ) {
    return null;
  }

  // `detail=summary` replays strip process payloads down to classification
  // metadata. The placeholder still needs an entry with the same id the full
  // event would get, so hydrating on expand can merge by id.
  if (payload.detailStub === true) {
    if (block) {
      const stubTitle = block.category === 'reasoning' ? '思考中'
        : block.category === 'tool' ? '工具调用'
        : block.category === 'assistant_progress' ? '进展' : '正在工作';
      return {
        ...base,
        id: `v2-block-${conversationId}-${block.turnId || 'turnless'}-${block.category}-${block.id}`,
        kind: 'system',
        title: stubTitle,
        subtitle: '',
        category: block.category,
        phase: block.phase,
        turnId: block.turnId,
        blockId: block.id,
        contentIndex: block.contentIndex,
        detailStub: true,
      };
    }
    const stubThought = type.startsWith('thought.')
      || /thought|reasoning|thinking|analysis/i.test(type)
      || /reasoning|thinking|analysis/i.test(deltaType)
      || /reasoning|thinking|analysis/i.test(providerMethod);
    const stubTool = /tool|command|function|mcp/i.test(type)
      || /tool|command|function|mcp/i.test(deltaType)
      || /tool|command|function|mcp/i.test(providerMethod)
      || messageRole === 'tool'
      || Boolean(payload.tool || payload.toolCall || payload.tool_call || payload.command || payload.function
        || payload.functionCall || payload.function_call);
    if (!stubThought && stubTool) {
      const stubToolId = readString(payload, ['toolCallId', 'tool_call_id', 'callId', 'call_id'])
        || readString(asRecord(payload.toolCall) || asRecord(payload.tool_call), ['id'])
        || (contentIndex >= 0 ? `content-${contentIndex}` : eventId);
      return {
        id: `v2-tool-${conversationId}-${turnId || 'current'}-${stubToolId}`,
        kind: 'system', title: '工具调用', subtitle: '', category: 'tool', detailStub: true, ...base,
      };
    }
    return {
      id: `v2-thought-${conversationId}-${streamId}`,
      kind: 'system', title: '思考中', subtitle: '', category: 'reasoning', detailStub: true, ...base,
    };
  }

  if (block) {
    if (block.category === 'usage') return null;
    const subtitle = blockContent(block.category, payload, message, delta);
    const id = `v2-block-${conversationId}-${block.turnId || 'turnless'}-${block.category}-${block.id}`;
    const semantic = {
      ...base,
      id,
      subtitle,
      category: block.category,
      phase: block.phase,
      turnId: block.turnId,
      blockId: block.id,
      contentIndex: block.contentIndex,
      sequence: readNumber(eventRecord, ['sequence'], 0),
      ...(block.supersedes ? { supersedes: block.supersedes } : {}),
    };
    switch (block.category) {
      case 'assistant_final':
        return subtitle ? { ...semantic, kind: 'incoming', title: 'Agent' } : null;
      case 'assistant_progress':
        return subtitle ? { ...semantic, kind: 'system', title: '进展' } : null;
      case 'reasoning':
        return subtitle ? { ...semantic, kind: 'system', title: '思考中' } : null;
      case 'tool':
        return { ...semantic, kind: 'system', title: '工具调用' };
      case 'approval':
        return {
          ...semantic,
          kind: 'system',
          title: '请求权限批准',
          requestId: readString(payload, ['permissionId', 'requestId', 'providerRequestId']),
        };
      case 'error':
        return { ...semantic, kind: 'system', title: '运行异常' };
      case 'status':
        return subtitle ? { ...semantic, kind: 'system', title: '正在工作' } : null;
      default:
        return null;
    }
  }

  const thoughtPayload = ['thought', 'thoughtText', 'thought_text', 'reasoning', 'thinking', 'analysis']
    .map((key) => textFromUnknown(payload[key]))
    .find(Boolean) || '';
  const isThoughtEvent = type.startsWith('thought.')
    || /thought|reasoning|thinking|analysis/i.test(type)
    || /reasoning|thinking|analysis/i.test(deltaType)
    || /reasoning|thinking|analysis/i.test(providerMethod)
    || Boolean(thoughtPayload);
  if (isThoughtEvent) {
    const thought = thoughtPayload || content;
    return thought
      ? { id: `v2-thought-${conversationId}-${streamId}`, kind: 'system', title: '思考中', subtitle: thought, ...base }
      : null;
  }

  const isToolEvent = /tool|command|function|mcp/i.test(type)
    || /tool|command|function|mcp/i.test(deltaType)
    || /tool|command|function|mcp/i.test(providerMethod)
    || messageRole === 'tool'
    || Boolean(payload.tool || payload.toolCall || payload.tool_call || payload.command || payload.function || payload.functionCall || payload.function_call);
  if (isToolEvent) {
    return {
      id: `v2-tool-${conversationId}-${turnId || 'current'}-${readString(payload, ['toolCallId', 'tool_call_id', 'callId', 'call_id']) || readString(asRecord(payload.toolCall) || asRecord(payload.tool_call), ['id']) || (contentIndex >= 0 ? `content-${contentIndex}` : eventId)}`,
      kind: 'system',
      title: '工具调用',
      subtitle: content || shortJsonValue(payload),
      ...base,
    };
  }

  if (type === 'message.created' || type === 'message.completed' || type === 'message.delta' || type.includes('agent') || type.includes('assistant')) {
    const answer = assistantContent(payload, message, delta);
    if (answer || type === 'message.created') {
      return {
        id: type === 'assistant.delta' || type === 'message.delta' || type === 'message.completed'
          ? `v2-assistant-${conversationId}-${turnId || 'current'}`
          : eventId,
        kind: 'incoming',
        title: 'Agent',
        subtitle: answer || type,
        ...base,
      };
    }
  }

  if (type === 'conversation.created' || type === 'turn.started' || type === 'turn.completed' || type === 'turn.cancelled') {
    return null;
  }
  if (type === 'permission.requested') {
    return {
      id: eventId,
      kind: 'system',
      title: '请求权限批准',
      subtitle: previewText(content || readString(payload, ['title']) || shortJsonValue(payload)),
      requestId: readString(payload, ['permissionId', 'requestId', 'providerRequestId']) || undefined,
      ...base,
    };
  }
  if (type.startsWith('mcp.') || type === 'skill.injected' || type.startsWith('permission.') || type === 'turn.failed') {
    return {
      id: eventId,
      kind: 'system',
      title: type,
      // turn.failed carries the user-facing failure reason; clipping it like a
      // generic payload preview cuts real diagnostics mid-word.
      subtitle: type === 'turn.failed'
        ? previewText(content || shortJsonValue(payload), FAILURE_MESSAGE_CHARS)
        : previewText(content || shortJsonValue(payload)),
      ...base,
    };
  }
  return null;
}

export function isLifecycleProgressText(text: string): boolean {
  return /^(starting|ready|started|completed|running|idle|busy)$/i.test(text.trim());
}

export function isChatReminderEntry(entry: Pick<TimelineEntry, 'subtitle' | 'title'>): boolean {
  const subtitle = typeof entry.subtitle === 'string' ? entry.subtitle : '';
  const title = typeof entry.title === 'string' ? entry.title : '';
  return subtitle.includes('本地会话启动超时')
    || title === '本地会话启动超时'
    || /^codex\.local\.(?:start|turn|attach|status|stop|interrupt)$/i.test(subtitle.trim());
}

function isLegacyPiNonFinalEntry(entry: TimelineEntry): boolean {
  if (entry.kind !== 'incoming' || !entry.raw || !/"provider"\s*:\s*"pi"/.test(entry.raw)) return false;
  try {
    const event = asRecord(JSON.parse(entry.raw));
    const payload = asRecord(event?.payload);
    const message = asRecord(payload?.message);
    const role = readString(message, ['role']);
    return readString(message, ['stopReason', 'stop_reason']) === 'toolUse'
      || Boolean(role && role !== 'assistant');
  } catch {
    // Older desktop snapshots may contain bounded JSON. The discriminators
    // occur before large tool results, so they remain safe to inspect.
    return /"stopReason"\s*:\s*"toolUse"/.test(entry.raw)
      || /"role"\s*:\s*"toolResult"/.test(entry.raw);
  }
}

export function isVisibleConversationEntry(entry: TimelineEntry): boolean {
  if (isChatReminderEntry(entry)) return false;
  if (entry.category === 'assistant_progress') return false;
  if (isLegacyPiNonFinalEntry(entry)) return false;
  if (entry.kind === 'outgoing' || entry.kind === 'incoming') return true;
  if (/^sent codex\./i.test(entry.title)) return false;
  if (entry.title === '协议指令' || entry.title === '已开始思考') return false;
  if (isLifecycleProgressText(entry.subtitle)) return false;
  return true;
}

export function isStepProgressEntry(entry: TimelineEntry): boolean {
  if (entry.kind !== 'system') return false;
  if (entry.category) {
    return ['reasoning', 'assistant_progress', 'tool', 'approval', 'status'].includes(entry.category);
  }
  return (
    entry.title === '执行步骤'
    || entry.title === '步骤完成'
    || entry.title === '请求权限批准'
    || entry.title === '工具调用'
    || entry.title === '思考中'
  );
}

export function isThinkingProgressEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'system' && (entry.category ? entry.category === 'reasoning' : entry.title === '思考中');
}

export function progressGroupLabel(
  entries: readonly TimelineEntry[],
  active: boolean,
  pendingCount = 0,
): string {
  if (pendingCount > 0) return '等待批准';
  if (!active) return '工作过程';
  const latestCategory = entries[entries.length - 1]?.category;
  if (latestCategory === 'reasoning') return '正在思考';
  if (latestCategory === 'tool' || latestCategory === 'approval') return '正在执行';
  return '正在工作';
}

export function isCollapsibleProgressEntry(entry: TimelineEntry): boolean {
  return isStepProgressEntry(entry) || isThinkingProgressEntry(entry);
}

/** Reply affordances attach to the last message of each turn, not to every
 * narration segment that interleaved steps split out of the stream. */
export function latestIncomingEntryIds(entries: readonly TimelineEntry[]): Set<string> {
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'incoming') continue;
    const key = entry.turnId || entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    ids.add(entry.id);
  }
  return ids;
}

export type ConversationRenderItem =
  | { type: 'entry'; entry: TimelineEntry }
  | { type: 'executionGroup'; id: string; entries: TimelineEntry[] };

export function executionGroupId(entries: TimelineEntry[]): string {
  const first = entries[0]?.id || 'empty';
  const conversationId = entries[0]?.conversationId || 'conversation';
  return `execution-group-${conversationId}-${entries[0]?.turnId || first}`;
}

export function buildConversationRenderItems(entries: TimelineEntry[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  let index = 0;
  while (index < entries.length) {
    if (!isStepProgressEntry(entries[index])) {
      items.push({ type: 'entry', entry: entries[index] });
      index += 1;
      continue;
    }
    const group: TimelineEntry[] = [];
    const turnId = entries[index].turnId;
    while (
      index < entries.length
      && isStepProgressEntry(entries[index])
      && (!turnId || !entries[index].turnId || entries[index].turnId === turnId)
    ) {
      group.push(entries[index]);
      index += 1;
    }
    items.push({ type: 'executionGroup', id: executionGroupId(group), entries: group });
  }
  return items;
}

export function conversationPreviewText(latest: TimelineEntry | undefined): string {
  const text = (latest?.subtitle || latest?.title || '').replace(/\s+/g, ' ').trim();
  return text || '新的对话';
}

export type WorkspaceLinkTarget =
  | { kind: 'browser-url'; url: string }
  | { kind: 'browser-file'; filePath: string }
  | { kind: 'file'; filePath: string }
  | null;

export type WorkspaceLinkOptions = {
  requireLoopback?: boolean;
};

function normalizeWorkspacePath(path: string): string {
  const prefix = path.startsWith('/') ? '/' : '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return `${prefix}${normalized.join('/')}` || prefix || '.';
}

export function workspaceLinkTarget(
  href: string | undefined,
  workspacePath: string | undefined,
  options: WorkspaceLinkOptions = {},
): WorkspaceLinkTarget {
  if (!href?.trim() || !workspacePath?.trim()) return null;
  const raw = href.trim();
  // Protocol-relative links must not be reinterpreted as workspace paths.
  if (raw.startsWith('//')) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (options.requireLoopback && !isLoopbackUrl(parsed)) return null;
      return { kind: 'browser-url', url: parsed.toString() };
    }
    return null;
  } catch {
    // Relative and absolute workspace paths are handled below.
  }
  const pathPart = raw.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  let decodedPath = pathPart;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  const root = normalizeWorkspacePath(workspacePath);
  const rootWithoutSlash = root === '/' ? '/' : root.replace(/\/$/, '');
  const candidate = normalizeWorkspacePath(decodedPath.startsWith('/')
    ? decodedPath
    : `${rootWithoutSlash}/${decodedPath}`);
  const insideRoot = rootWithoutSlash === '/'
    ? candidate.startsWith('/')
    : candidate === rootWithoutSlash || candidate.startsWith(`${rootWithoutSlash}/`);
  if (!insideRoot) return null;
  const extension = candidate.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml' || extension === 'svg') {
    return { kind: 'browser-file', filePath: candidate };
  }
  return { kind: 'file', filePath: candidate };
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (typeof hostname !== 'string') return false;
  const host = normalizedHostname(hostname);
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = host.split('.');
  if (ipv4.length === 4 && ipv4[0] === '127') {
    return ipv4.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  }
  // URL.hostname can expose an IPv4-mapped IPv6 loopback address.
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isLoopbackHostname(mapped[1]);
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    const mappedIpv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return isLoopbackHostname(mappedIpv4);
  }
  return false;
}

export function isLoopbackUrl(value: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return isLoopbackHostname(parsed.hostname);
}

export type LoopbackUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function validateLoopbackUrl(value: string | null | undefined): LoopbackUrlValidation {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return { ok: false, reason: 'missing URL' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'only HTTP(S) URLs are supported' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials are not allowed' };
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return { ok: false, reason: 'URL must point to localhost or 127.0.0.0/8' };
  }
  return { ok: true, url: parsed.toString() };
}

export type ProviderIconMetadata = {
  id: string;
  label: string;
  icon: string;
  iconName: string;
  color: string;
  backgroundColor: string;
  accessibilityLabel: string;
};

const PROVIDER_ICON_FALLBACK: ProviderIconMetadata = {
  id: 'unknown',
  label: 'Agent',
  icon: 'cube-outline',
  iconName: 'cube-outline',
  color: '#66717c',
  backgroundColor: '#edf0f2',
  accessibilityLabel: 'Agent',
};

export const PROVIDER_ICON_METADATA: Readonly<Record<string, ProviderIconMetadata>> = Object.freeze({
  acp: {
    id: 'acp',
    label: 'ACP',
    icon: 'git-network-outline',
    iconName: 'git-network-outline',
    color: '#7c5cbf',
    backgroundColor: '#f0eafd',
    accessibilityLabel: 'ACP',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    icon: 'code-slash-outline',
    iconName: 'code-slash-outline',
    color: '#2b7a70',
    backgroundColor: '#e2f4ef',
    accessibilityLabel: 'Codex CLI',
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    icon: 'radio-outline',
    iconName: 'radio-outline',
    color: '#b26a2b',
    backgroundColor: '#fbefe2',
    accessibilityLabel: 'Pi',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    icon: 'sparkles-outline',
    iconName: 'sparkles-outline',
    color: '#b4573f',
    backgroundColor: '#f9e8e2',
    accessibilityLabel: 'Claude Code',
  },
  'grok-build': {
    id: 'grok-build',
    label: 'Grok Build',
    icon: 'hammer-outline',
    iconName: 'hammer-outline',
    color: '#3d6c8e',
    backgroundColor: '#e5f0f6',
    accessibilityLabel: 'Grok Build',
  },
  devin: {
    id: 'devin',
    label: 'Devin',
    icon: 'layers-outline',
    iconName: 'layers-outline',
    color: '#2f6b4f',
    backgroundColor: '#e4f1ea',
    accessibilityLabel: 'Devin',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    icon: 'terminal-outline',
    iconName: 'terminal-outline',
    color: '#5b4a8a',
    backgroundColor: '#ece7f6',
    accessibilityLabel: 'OpenCode',
  },
});

function canonicalProviderId(value: string): string {
  const id = value.trim().toLowerCase();
  if (id === 'claude-code' || id.includes('claude')) return 'claude-code';
  if (id === 'codex' || id.includes('codex')) return 'codex';
  if (id === 'pi' || id.startsWith('pi-')) return 'pi';
  if (id === 'acp') return 'acp';
  if (id === 'grok-build' || id === 'grok' || id === 'grok_build') return 'grok-build';
  if (id === 'devin' || id === 'devin-cli' || id === 'devin_cli') return 'devin';
  if (id === 'opencode' || id === 'open-code' || id === 'open_code') return 'opencode';
  return id;
}

/** Return icon metadata suitable for Ionicons/Touchable mobile components. */
export function providerIconMetadata(provider?: string | null): ProviderIconMetadata {
  const raw = provider?.trim() || '';
  const id = canonicalProviderId(raw);
  const known = PROVIDER_ICON_METADATA[id];
  if (known) return { ...known };
  if (!raw) return { ...PROVIDER_ICON_FALLBACK };
  return {
    ...PROVIDER_ICON_FALLBACK,
    id,
    label: raw,
    accessibilityLabel: raw,
  };
}

export const providerIconFor = providerIconMetadata;
