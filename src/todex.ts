export type AppTab = 'chat' | 'settings';

export type ConnectionSettings = {
  serverUrl: string;
  /** Legacy bearer token; device-identity signing supersedes it. */
  authToken?: string;
  /** Base64url Ed25519 seed issued during device pairing; '' when unpaired. */
  deviceSecret: string;
  tenantId: string;
  encryptionProtocol: 'none' | 'x25519' | 'ml-kem-768';
  encryptionPublicKey: string;
  defaultWorkspacePath: string;
  defaultModel: string;
  defaultReasoningEffort?: string | null;
  approvalPolicy: string;
  approvalsReviewer?: string | null;
  sandboxMode: string;
};

export type BackendConnectionProfile = {
  id: string;
  name: string;
  serverUrl: string;
  /** Legacy bearer token; device-identity signing supersedes it. */
  authToken?: string;
  /** Base64url Ed25519 seed issued during device pairing; '' when unpaired. */
  deviceSecret: string;
  tenantId: string;
  encryptionProtocol: ConnectionSettings['encryptionProtocol'];
  encryptionPublicKey: string;
  createdAt: number;
  updatedAt: number;
};

export type CodexModelCatalogItem = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string | null;
  serviceTiers: CodexServiceTierOption[];
};

export type CodexReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexServiceTierOption = {
  id: string;
  name: string;
  description: string;
};

export type CodexMcpServerStatus = {
  name: string;
  title: string;
  version: string;
  description: string;
  authStatus: string;
  tools: string[];
  resources: string[];
  resourceTemplates: string[];
  raw: Record<string, unknown>;
};

export type CodexPermissionProfileSummary = {
  id: string;
  description: string;
};

export type CodexHookSummary = {
  key: string;
  eventName: string;
  handlerType: string;
  matcher: string;
  command: string;
  sourcePath: string;
  enabled: boolean;
  trustStatus: string;
  pluginId: string;
};

export type CodexHooksListEntry = {
  cwd: string;
  hooks: CodexHookSummary[];
  warnings: string[];
  errors: string[];
};

export type CodexPluginSummary = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  source: string;
  installed: boolean;
  enabled: boolean;
  availability: string;
};

export type CodexPluginMarketplaceSummary = {
  name: string;
  displayName: string;
  path: string;
  plugins: CodexPluginSummary[];
};

export type CodexPluginListResult = {
  marketplaces: CodexPluginMarketplaceSummary[];
  marketplaceLoadErrors: string[];
  featuredPluginIds: string[];
};

export type CodexMemorySettings = {
  useMemories: boolean;
  generateMemories: boolean;
};

export type LocalAdapterState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export type WorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  backendConnectionId?: string | null;
  sessionId: string;
  tenantId: string;
  threadId: string;
  model: string;
  reasoningEffort?: string | null;
  approvalPolicy: string;
  approvalsReviewer?: string | null;
  sandboxMode: string;
  serviceTier?: string | null;
  permissionProfile?: string | null;
  personality?: string | null;
  localAdapterState?: LocalAdapterState;
  createdAt: number;
  updatedAt: number;
  sortOrder?: number;
};

export type CapabilityHashTrigger = {
  start: number;
  end: number;
  query: string;
};

export function findCapabilityHashTrigger(text: string, cursor: number): CapabilityHashTrigger | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, end);
  const hashIndex = beforeCursor.lastIndexOf('#');
  if (hashIndex < 0) return null;
  const prefix = beforeCursor.slice(0, hashIndex);
  if (prefix && !/\s$/.test(prefix)) return null;
  const query = beforeCursor.slice(hashIndex + 1);
  if (/\s/.test(query) || query.includes('#')) return null;
  return { start: hashIndex, end, query };
}

export function insertCapabilityReference(text: string, trigger: CapabilityHashTrigger, value: string): string {
  return `${text.slice(0, trigger.start)}${value}${text.slice(trigger.end)}`;
}

export type CodexNativeThread = {
  id: string;
  title: string;
  preview: string;
  name: string;
  status: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  sessionId: string;
  raw: Record<string, unknown>;
};

export type CodexThreadHistoryEntry = {
  id: string;
  kind: 'incoming' | 'outgoing';
  title: string;
  subtitle: string;
  raw: string;
  at: number;
};

export type ServerEvent = {
  event_id?: string;
  id?: string;
  type: string;
  cursor?: number | string;
  codex_session_id?: string;
  codex_thread_id?: string;
  codex_turn_id?: string;
  workspace_id?: string;
  window_id?: string;
  pane_id?: string;
  payload: unknown;
};

export type PendingRequest = {
  requestId: string;
  requestType: string;
  title: string;
  event: ServerEvent;
  data: Record<string, unknown>;
};

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | 'abort_turn'
  | 'answer';

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
};

export type PermissionDecision = {
  outcome: PermissionOptionKind;
  optionId?: string;
  data?: Record<string, unknown>;
};

const PERMISSION_OPTION_KINDS = new Set<PermissionOptionKind>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
  'abort_turn',
  'answer',
]);

export function permissionOptions(request: PendingRequest): PermissionOption[] {
  const raw = request.data.options;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: PermissionOption[] = [];
  for (const value of raw) {
    if (!isObject(value)) return [];
    const optionId = typeof value.optionId === 'string' ? value.optionId.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const kind = typeof value.kind === 'string' ? value.kind : '';
    if (!optionId || !name || seen.has(optionId) || !PERMISSION_OPTION_KINDS.has(kind as PermissionOptionKind)) {
      return [];
    }
    seen.add(optionId);
    options.push({ optionId, name, kind: kind as PermissionOptionKind });
  }
  return options;
}

export function permissionActions(request: PendingRequest): Array<boolean | PermissionOption> {
  if (request.data.options === undefined) return [true, false];
  const options = permissionOptions(request);
  return options.length ? options : [false];
}

export function permissionDecision(
  selection: boolean | PermissionOption,
  data?: Record<string, unknown>,
): PermissionDecision {
  if (typeof selection === 'boolean') {
    return { outcome: selection ? 'allow_once' : 'reject_once', ...(data ? { data } : {}) };
  }
  return {
    outcome: selection.kind,
    optionId: selection.optionId,
    ...(data ? { data } : {}),
  };
}

export type CommandContext = {
  settings: ConnectionSettings;
  workspace: WorkspaceRecord | null;
  threadId: string;
  turnId: string;
  prompt: string;
  selectedRequest: PendingRequest | null;
};

export type CommandPreset = {
  group: string;
  label: string;
  type: string;
  description: string;
  build: (ctx: CommandContext) => Record<string, unknown>;
};

export type SendableMessage = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export function createRequestId(prefix = 'req'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * UTF-8 byte length of a string. String.length counts UTF-16 code units, which
 * undercounts non-ASCII text, while the backend message limits are in bytes.
 * Counted in place rather than via TextEncoder.encode().length so multi-megabyte
 * frames are not copied on every send.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Well-formed surrogate pair: one code point, four bytes.
        bytes += 4;
        index += 1;
        continue;
      }
      // Lone surrogate; encoders emit U+FFFD, which is three bytes.
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

export function normalizeServerUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return 'http://127.0.0.1:7345';
  }

  let candidate = value;
  if (!/^https?:\/\//i.test(candidate) && !/^wss?:\/\//i.test(candidate)) {
    if (candidate.startsWith('[') || candidate.includes('::')) {
      candidate = `http://${candidate}`;
    } else {
      candidate = `http://${candidate}`;
    }
  }
  candidate = candidate.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');

  try {
    const parsed = new URL(candidate);
    let hostname = parsed.hostname;
    if (isLoopbackHostname(hostname)) {
      hostname = '127.0.0.1';
    }
    const protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const origin = parsed.port ? `${protocol}//${host}:${parsed.port}` : `${protocol}//${host}`;
    return origin.replace(/\/+$/, '');
  } catch {
    return candidate.replace(/\/+$/, '');
  }
}

export function normalizeReasoningEffort(value: string | null | undefined): string | null {
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

const REASONING_EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'No model reasoning',
  minimal: 'Minimal reasoning for fastest responses',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
};

export const DEFAULT_REASONING_EFFORT_OPTIONS: CodexReasoningEffortOption[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
].map((reasoningEffort) => ({
  reasoningEffort,
  description: REASONING_EFFORT_DESCRIPTIONS[reasoningEffort] ?? reasoningEffort,
}));

export const FAST_SERVICE_TIER: CodexServiceTierOption = {
  id: 'priority',
  name: 'fast',
  description: 'Fastest inference with increased plan usage.',
};

export const FALLBACK_CODEX_MODELS: CodexModelCatalogItem[] = [
  {
    id: 'gpt-5.5',
    model: 'gpt-5.5',
    displayName: 'gpt-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: DEFAULT_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    id: 'gpt-5.4',
    model: 'gpt-5.4',
    displayName: 'gpt-5.4',
    description: 'Strong model for everyday coding.',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: DEFAULT_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    id: 'gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    displayName: 'gpt-5.4-mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: DEFAULT_REASONING_EFFORT_OPTIONS.filter((option) => option.reasoningEffort !== 'xhigh'),
    defaultReasoningEffort: 'medium',
    serviceTiers: [FAST_SERVICE_TIER],
  },
  {
    id: 'gpt-5.3-codex',
    model: 'gpt-5.3-codex',
    displayName: 'gpt-5.3-codex',
    description: 'Coding-optimized model.',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: DEFAULT_REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    serviceTiers: [FAST_SERVICE_TIER],
  },
];

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function booleanField(record: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return fallback;
}

function numberField(record: Record<string, unknown>, keys: string[], fallback = 0): number {
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

function parseReasoningEffortOptions(value: unknown, defaultEffort: string | null): CodexReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    return defaultEffort
      ? [{ reasoningEffort: defaultEffort, description: REASONING_EFFORT_DESCRIPTIONS[defaultEffort] ?? defaultEffort }]
      : DEFAULT_REASONING_EFFORT_OPTIONS;
  }

  const options = value
    .map((item): CodexReasoningEffortOption | null => {
      if (typeof item === 'string') {
        const normalized = normalizeReasoningEffort(item);
        return normalized
          ? {
              reasoningEffort: normalized,
              description: REASONING_EFFORT_DESCRIPTIONS[normalized] ?? normalized,
            }
          : null;
      }
      if (!isObject(item)) {
        return null;
      }
      const effort = normalizeReasoningEffort(
        stringField(item, ['reasoningEffort', 'reasoning_effort', 'effort', 'level']),
      );
      if (!effort) {
        return null;
      }
      return {
        reasoningEffort: effort,
        description: stringField(item, ['description', 'label']) || REASONING_EFFORT_DESCRIPTIONS[effort] || effort,
      };
    })
    .filter((item): item is CodexReasoningEffortOption => Boolean(item));

  if (!options.length && defaultEffort) {
    return [{ reasoningEffort: defaultEffort, description: REASONING_EFFORT_DESCRIPTIONS[defaultEffort] ?? defaultEffort }];
  }

  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.reasoningEffort)) {
      return false;
    }
    seen.add(option.reasoningEffort);
    return true;
  });
}

function parseServiceTierOptions(value: unknown): CodexServiceTierOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options = value
    .map((item): CodexServiceTierOption | null => {
      if (typeof item === 'string') {
        const name = item.trim().toLowerCase();
        if (!name) {
          return null;
        }
        return {
          id: name === 'fast' ? FAST_SERVICE_TIER.id : name,
          name,
          description: name === 'fast' ? FAST_SERVICE_TIER.description : name,
        };
      }
      if (!isObject(item)) {
        return null;
      }
      const id = stringField(item, ['id', 'value', 'requestValue', 'request_value']);
      const name = (stringField(item, ['name', 'label', 'displayName', 'display_name']) || id).toLowerCase();
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        description: stringField(item, ['description']) || (name === 'fast' ? FAST_SERVICE_TIER.description : name),
      };
    })
    .filter((item): item is CodexServiceTierOption => Boolean(item));

  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.id}:${option.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function modelCatalogArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObject(value)) {
    return [];
  }
  if (isObject(value.payload)) {
    const payloadData = isObject(value.payload.data) ? value.payload.data : value.payload;
    const nested = modelCatalogArray(payloadData);
    if (nested.length) {
      return nested;
    }
  }
  if (isObject(value.result)) {
    const nested = modelCatalogArray(value.result);
    if (nested.length) {
      return nested;
    }
  }
  for (const key of ['data', 'models', 'items']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return [];
}

export function parseCodexModelListResponse(value: unknown): CodexModelCatalogItem[] {
  const items = modelCatalogArray(value);
  const parsed = items
    .map((item): CodexModelCatalogItem | null => {
      if (!isObject(item)) {
        return null;
      }
      const model = stringField(item, ['model', 'slug', 'id']);
      if (!model) {
        return null;
      }
      const defaultReasoningEffort = normalizeReasoningEffort(
        stringField(item, ['defaultReasoningEffort', 'default_reasoning_effort', 'default_reasoning_level']),
      );
      const supportedReasoningEfforts = parseReasoningEffortOptions(
        item.supportedReasoningEfforts ?? item.supported_reasoning_efforts ?? item.supported_reasoning_levels,
        defaultReasoningEffort,
      );
      return {
        id: stringField(item, ['id']) || model,
        model,
        displayName: stringField(item, ['displayName', 'display_name', 'name']) || model,
        description: stringField(item, ['description']),
        hidden: booleanField(item, ['hidden'], false),
        isDefault: booleanField(item, ['isDefault', 'is_default'], false),
        supportedReasoningEfforts,
        defaultReasoningEffort:
          defaultReasoningEffort ??
          supportedReasoningEfforts.find((option) => option.reasoningEffort === 'medium')?.reasoningEffort ??
          supportedReasoningEfforts[0]?.reasoningEffort ??
          null,
        serviceTiers: parseServiceTierOptions(item.serviceTiers ?? item.service_tiers ?? item.speedTiers ?? item.speed_tiers),
      };
    })
    .filter((item): item is CodexModelCatalogItem => Boolean(item));

  const byModel = new Map<string, CodexModelCatalogItem>();
  parsed.forEach((item) => {
    if (!item.hidden || !byModel.has(item.model)) {
      byModel.set(item.model, item);
    }
  });
  return [...byModel.values()];
}

export function buildHttpUrl(serverUrl: string, pathname: string): string {
  const url = normalizeServerUrl(serverUrl);
  const normalized = url.startsWith('ws://')
    ? url.replace(/^ws:\/\//i, 'http://')
    : url.startsWith('wss://')
      ? url.replace(/^wss:\/\//i, 'https://')
      : url;
  return new URL(pathname, normalized).toString();
}

export function displayNameFromPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return 'Workspace';
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'Workspace';
}

export function normalizeWorkspaceRecord(value: unknown): WorkspaceRecord | null {
  if (!isObject(value)) {
    return null;
  }

  const id = stringField(value, ['id']).trim();
  const path = stringField(value, ['path', 'cwd']).trim();
  if (!id || !path) {
    return null;
  }

  const now = Date.now();
  const name = stringField(value, ['name']).trim() || displayNameFromPath(path);
  const createdAt = numberField(value, ['createdAt', 'created_at']) || now;
  const updatedAt = numberField(value, ['updatedAt', 'updated_at']) || createdAt;
  const localAdapterState = normalizeLocalAdapterState(stringField(value, ['localAdapterState', 'local_adapter_state']));
  const sortOrder = numberField(value, ['sortOrder', 'sort_order'], Number.NaN);

  return {
    id,
    name,
    path,
    backendConnectionId: stringField(value, ['backendConnectionId', 'backend_connection_id']) || null,
    sessionId: stringField(value, ['sessionId', 'session_id']) || `cdxs_${id}`,
    tenantId: stringField(value, ['tenantId', 'tenant_id']) || 'local',
    threadId: stringField(value, ['threadId', 'thread_id']),
    model: stringField(value, ['model']) || 'gpt-5.5',
    reasoningEffort: normalizeReasoningEffort(stringField(value, ['reasoningEffort', 'reasoning_effort'])) ?? null,
    approvalPolicy: stringField(value, ['approvalPolicy', 'approval_policy']) || 'on-request',
    approvalsReviewer: stringField(value, ['approvalsReviewer', 'approvals_reviewer']) || null,
    sandboxMode: stringField(value, ['sandboxMode', 'sandbox_mode']) || 'workspace-write',
    serviceTier: stringField(value, ['serviceTier', 'service_tier']) || null,
    permissionProfile: stringField(value, ['permissionProfile', 'permission_profile', 'permissions']) || null,
    personality: stringField(value, ['personality']) || null,
    localAdapterState,
    createdAt,
    updatedAt,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
  };
}

export function parseWorkspaceSyncResponse(value: unknown): WorkspaceRecord[] {
  const rawWorkspaces = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.workspaces)
      ? value.workspaces
      : [];
  return rawWorkspaces
    .map(normalizeWorkspaceRecord)
    .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace));
}

export function prepareWorkspaceSyncPayload(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
  return workspaces
    .map(normalizeWorkspaceRecord)
    .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace))
    .map((workspace) => ({
      ...workspace,
      backendConnectionId: undefined,
      threadId: '',
      localAdapterState: 'idle' as LocalAdapterState,
      reasoningEffort: normalizeReasoningEffort(workspace.reasoningEffort) ?? null,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function mergeWorkspaceRecords(local: WorkspaceRecord[], remote: WorkspaceRecord[]): WorkspaceRecord[] {
  const merged: WorkspaceRecord[] = [];

  const upsert = (candidate: WorkspaceRecord, preferCandidateOnTie: boolean) => {
    const normalized = normalizeWorkspaceRecord(candidate);
    if (!normalized) {
      return;
    }
    const existingIndex = merged.findIndex((workspace) => sameWorkspaceRecord(workspace, normalized));
    if (existingIndex === -1) {
      merged.push(normalized);
      return;
    }

    const existing = merged[existingIndex];
    const candidateUpdatedAt = Number.isFinite(normalized.updatedAt) ? normalized.updatedAt : 0;
    const existingUpdatedAt = Number.isFinite(existing.updatedAt) ? existing.updatedAt : 0;
    const adoptsRemoteIdentity = preferCandidateOnTie && existing.id !== normalized.id;
    if (candidateUpdatedAt > existingUpdatedAt || (preferCandidateOnTie && candidateUpdatedAt === existingUpdatedAt) || adoptsRemoteIdentity) {
      const base = candidateUpdatedAt >= existingUpdatedAt ? normalized : existing;
      merged[existingIndex] = {
        ...base,
        id: normalized.id,
        sessionId: normalized.sessionId,
        tenantId: normalized.tenantId,
        backendConnectionId: normalized.backendConnectionId ?? existing.backendConnectionId ?? null,
        localAdapterState: preserveRuntimeAdapterState(existing.localAdapterState, normalized.localAdapterState),
        sortOrder: normalized.sortOrder ?? existing.sortOrder,
      };
    }
  };

  local.forEach((workspace) => upsert(workspace, false));
  remote.forEach((workspace) => upsert(workspace, true));
  return merged
    .map((workspace) => ({
      ...workspace,
      reasoningEffort: normalizeReasoningEffort(workspace.reasoningEffort) ?? null,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export type KanbanTaskStatus = 'planned' | 'in-progress' | 'done';
export const KANBAN_TASK_STATUSES: readonly KanbanTaskStatus[] = ['planned', 'in-progress', 'done'];

export type KanbanTask = {
  id: string;
  workspaceId: string;
  /** Local-only tag scoping the task to a backend connection; never synced. */
  backendConnectionId?: string | null;
  title: string;
  description?: string;
  dueDate?: string;
  status: KanbanTaskStatus;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
  /** Tombstone timestamp; deletions sync through it instead of disappearing. */
  deletedAt?: number;
};

const KANBAN_DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeKanbanTaskStatus(value: string): KanbanTaskStatus {
  return (KANBAN_TASK_STATUSES as readonly string[]).includes(value)
    ? (value as KanbanTaskStatus)
    : 'planned';
}

export function normalizeKanbanTask(value: unknown): KanbanTask | null {
  if (!isObject(value)) {
    return null;
  }
  const id = stringField(value, ['id']).trim();
  const workspaceId = stringField(value, ['workspaceId', 'workspace_id']).trim();
  const title = stringField(value, ['title']).trim();
  if (!id || !workspaceId || !title) {
    return null;
  }
  const now = Date.now();
  const createdAt = numberField(value, ['createdAt', 'created_at']) || now;
  const updatedAt = numberField(value, ['updatedAt', 'updated_at']) || createdAt;
  const deletedAt = numberField(value, ['deletedAt', 'deleted_at']);
  const description = stringField(value, ['description']).trim();
  const dueDate = stringField(value, ['dueDate', 'due_date']).trim();
  const conversationId = stringField(value, ['conversationId', 'conversation_id']).trim();
  return {
    id,
    workspaceId,
    backendConnectionId: stringField(value, ['backendConnectionId', 'backend_connection_id']) || null,
    title,
    ...(description ? { description } : {}),
    ...(dueDate && KANBAN_DUE_DATE_PATTERN.test(dueDate) ? { dueDate } : {}),
    status: normalizeKanbanTaskStatus(stringField(value, ['status'])),
    ...(conversationId ? { conversationId } : {}),
    createdAt,
    updatedAt,
    ...(deletedAt ? { deletedAt } : {}),
  };
}

export function parseKanbanSyncResponse(value: unknown): KanbanTask[] {
  const rawTasks = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.tasks)
      ? value.tasks
      : [];
  return rawTasks
    .map(normalizeKanbanTask)
    .filter((task): task is KanbanTask => Boolean(task));
}

export function prepareKanbanSyncPayload(tasks: KanbanTask[]): KanbanTask[] {
  return tasks
    .map(normalizeKanbanTask)
    .filter((task): task is KanbanTask => Boolean(task))
    .map((task) => ({ ...task, backendConnectionId: undefined }))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** Last-writer-wins merge by task id; remote wins `updatedAt` ties so
 * concurrent editors converge. Tombstones survive so deletions propagate. */
export function mergeKanbanTasks(local: KanbanTask[], remote: KanbanTask[]): KanbanTask[] {
  const byId = new Map<string, KanbanTask>();
  const upsert = (candidate: unknown, preferCandidateOnTie: boolean) => {
    const task = normalizeKanbanTask(candidate);
    if (!task) {
      return;
    }
    const existing = byId.get(task.id);
    if (
      !existing
      || task.updatedAt > existing.updatedAt
      || (preferCandidateOnTie && task.updatedAt === existing.updatedAt)
    ) {
      byId.set(task.id, task);
    }
  };
  local.forEach((task) => upsert(task, false));
  remote.forEach((task) => upsert(task, true));
  return [...byId.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

export function nextWorkspaceSortOrder(workspaces: WorkspaceRecord[]): number {
  return workspaces.reduce(
    (max, workspace) => Math.max(max, (workspace.sortOrder ?? -1) + 1),
    0,
  );
}

export function remapWorkspaceScopedRecords<T extends { workspaceId?: string }>(
  records: T[],
  previousWorkspaces: WorkspaceRecord[],
  nextWorkspaces: WorkspaceRecord[],
): T[] {
  const idMap = new Map<string, string>();
  for (const previous of previousWorkspaces) {
    const next = nextWorkspaces.find((workspace) => sameWorkspaceRecord(previous, workspace));
    if (next && next.id !== previous.id) {
      idMap.set(previous.id, next.id);
    }
  }
  return records.map((record) => {
    const workspaceId = record.workspaceId ? idMap.get(record.workspaceId) : undefined;
    return workspaceId ? { ...record, workspaceId } : record;
  });
}

function responseDataArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObject(value)) {
    return [];
  }
  if (isObject(value.payload)) {
    const nested = responseDataArray(value.payload);
    if (nested.length) {
      return nested;
    }
  }
  if (isObject(value.result)) {
    const nested = responseDataArray(value.result);
    if (nested.length) {
      return nested;
    }
  }
  for (const key of ['data', 'items', 'profiles', 'servers']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return [];
}

function objectKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value) : [];
}

function namedItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (isObject(item) ? stringField(item, ['name', 'uri', 'title']) : typeof item === 'string' ? item : ''))
      .filter(Boolean);
  }
  return objectKeys(value);
}

export function parseMcpServerStatusListResponse(value: unknown): CodexMcpServerStatus[] {
  return responseDataArray(value)
    .map((item): CodexMcpServerStatus | null => {
      if (!isObject(item)) {
        return null;
      }
      const name = stringField(item, ['name', 'server', 'serverName']);
      if (!name) {
        return null;
      }
      const serverInfo = isObject(item.serverInfo) ? item.serverInfo : isObject(item.server_info) ? item.server_info : {};
      return {
        name,
        title: stringField(serverInfo, ['title', 'name']),
        version: stringField(serverInfo, ['version']),
        description: stringField(serverInfo, ['description']),
        authStatus: stringField(item, ['authStatus', 'auth_status']) || 'unknown',
        tools: namedItems(item.tools),
        resources: namedItems(item.resources),
        resourceTemplates: namedItems(item.resourceTemplates ?? item.resource_templates),
        raw: item,
      };
    })
    .filter((item): item is CodexMcpServerStatus => Boolean(item));
}

export function parsePermissionProfileListResponse(value: unknown): CodexPermissionProfileSummary[] {
  return responseDataArray(value)
    .map((item): CodexPermissionProfileSummary | null => {
      if (!isObject(item)) {
        return null;
      }
      const id = stringField(item, ['id', 'name']);
      if (!id) {
        return null;
      }
      return {
        id,
        description: stringField(item, ['description']) || 'Configured permission profile.',
      };
    })
    .filter((item): item is CodexPermissionProfileSummary => Boolean(item));
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {};
  }
  if (isObject(value.payload)) {
    const nested = responseObject(value.payload.data ?? value.payload);
    if (Object.keys(nested).length) {
      return nested;
    }
  }
  if (isObject(value.result)) {
    const nested = responseObject(value.result);
    if (Object.keys(nested).length) {
      return nested;
    }
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      if (isObject(item)) {
        return stringField(item, ['message', 'summary', 'path', 'key', 'name']);
      }
      return '';
    })
    .filter(Boolean);
}

export function parseHooksListResponse(value: unknown): CodexHooksListEntry[] {
  return responseDataArray(value)
    .map((entry): CodexHooksListEntry | null => {
      if (!isObject(entry)) {
        return null;
      }
      const cwd = stringField(entry, ['cwd', 'path']) || 'workspace';
      const hooks = Array.isArray(entry.hooks)
        ? entry.hooks
            .map((hook): CodexHookSummary | null => {
              if (!isObject(hook)) {
                return null;
              }
              const key = stringField(hook, ['key', 'id', 'name']);
              if (!key) {
                return null;
              }
              return {
                key,
                eventName: stringField(hook, ['eventName', 'event_name']),
                handlerType: stringField(hook, ['handlerType', 'handler_type']),
                matcher: stringField(hook, ['matcher']),
                command: stringField(hook, ['command']),
                sourcePath: stringField(hook, ['sourcePath', 'source_path', 'path']),
                enabled: booleanField(hook, ['enabled'], true),
                trustStatus: stringField(hook, ['trustStatus', 'trust_status']),
                pluginId: stringField(hook, ['pluginId', 'plugin_id']),
              };
            })
            .filter((hook): hook is CodexHookSummary => Boolean(hook))
        : [];
      return {
        cwd,
        hooks,
        warnings: stringList(entry.warnings),
        errors: stringList(entry.errors),
      };
    })
    .filter((entry): entry is CodexHooksListEntry => Boolean(entry));
}

export function parsePluginListResponse(value: unknown): CodexPluginListResult {
  const root = responseObject(value);
  const marketplaces = Array.isArray(root.marketplaces)
    ? root.marketplaces
        .map((marketplace): CodexPluginMarketplaceSummary | null => {
          if (!isObject(marketplace)) {
            return null;
          }
          const name = stringField(marketplace, ['name', 'id']);
          if (!name) {
            return null;
          }
          const iface = isObject(marketplace.interface) ? marketplace.interface : {};
          const plugins = Array.isArray(marketplace.plugins)
            ? marketplace.plugins
                .map((plugin): CodexPluginSummary | null => {
                  if (!isObject(plugin)) {
                    return null;
                  }
                  const pluginName = stringField(plugin, ['name', 'id']);
                  if (!pluginName) {
                    return null;
                  }
                  const pluginInterface = isObject(plugin.interface) ? plugin.interface : {};
                  const source = isObject(plugin.source) ? stringField(plugin.source, ['type']) : stringField(plugin, ['source']);
                  return {
                    id: stringField(plugin, ['id']) || pluginName,
                    name: pluginName,
                    displayName: stringField(pluginInterface, ['displayName', 'display_name']) || pluginName,
                    description: stringField(pluginInterface, ['shortDescription', 'short_description', 'longDescription', 'long_description']),
                    category: stringField(pluginInterface, ['category']),
                    source,
                    installed: booleanField(plugin, ['installed']),
                    enabled: booleanField(plugin, ['enabled']),
                    availability: stringField(plugin, ['availability']) || 'AVAILABLE',
                  };
                })
                .filter((plugin): plugin is CodexPluginSummary => Boolean(plugin))
            : [];
          return {
            name,
            displayName: stringField(iface, ['displayName', 'display_name']) || name,
            path: stringField(marketplace, ['path']),
            plugins,
          };
        })
        .filter((marketplace): marketplace is CodexPluginMarketplaceSummary => Boolean(marketplace))
    : [];
  return {
    marketplaces,
    marketplaceLoadErrors: stringList(root.marketplaceLoadErrors ?? root.marketplace_load_errors),
    featuredPluginIds: stringList(root.featuredPluginIds ?? root.featured_plugin_ids),
  };
}

export function parseMemorySettingsResponse(value: unknown): CodexMemorySettings {
  const root = responseObject(value);
  const config = isObject(root.config) ? root.config : root;
  const memories = isObject(config.memories) ? config.memories : {};
  return {
    useMemories: booleanField(memories, ['useMemories', 'use_memories']),
    generateMemories: booleanField(memories, ['generateMemories', 'generate_memories']),
  };
}

function sameWorkspaceRecord(left: WorkspaceRecord, right: WorkspaceRecord): boolean {
  if (left.id && right.id && left.id === right.id) {
    return true;
  }
  return normalizeWorkspacePath(left.path) === normalizeWorkspacePath(right.path);
}

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '');
}

function normalizeLocalAdapterState(value: string): LocalAdapterState | undefined {
  switch (value) {
    case 'idle':
    case 'starting':
    case 'running':
    case 'stopped':
    case 'error':
      return value;
    default:
      return undefined;
  }
}

function preserveRuntimeAdapterState(
  previous: LocalAdapterState | undefined,
  next: LocalAdapterState | undefined,
): LocalAdapterState | undefined {
  if (previous === 'starting' || previous === 'running') {
    return previous;
  }
  return next;
}

export function eventPayloadData(event: ServerEvent): Record<string, unknown> {
  if (isObject(event.payload) && isObject(event.payload.data)) {
    return event.payload.data;
  }
  return isObject(event.payload) ? event.payload : {};
}

export function normalizeThreadId(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function isThreadNotMaterializedHistoryError(text: string): boolean {
  return /not materialized yet/i.test(text) && /includeTurns is unavailable before first user message/i.test(text);
}

export function extractThreadIdFromEvent(event: ServerEvent): string {
  const data = eventPayloadData(event);
  const candidates = [
    data.threadId,
    data.thread_id,
    data.codexThreadId,
    data.codex_thread_id,
    event.codex_thread_id,
  ];

  const result = data.result;
  if (isObject(result)) {
    candidates.push(result.threadId, result.thread_id, result.codexThreadId, result.codex_thread_id, result.id);
    const thread = result.thread;
    if (isObject(thread)) {
      candidates.push(thread.id, thread.threadId, thread.thread_id);
    }
  }

  const payload = data.payload;
  if (isObject(payload)) {
    candidates.push(payload.threadId, payload.thread_id, payload.codexThreadId, payload.codex_thread_id);
  }

  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof value === 'string' ? normalizeThreadId(value) : '';
}

function timestampField(record: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function threadStatusLabel(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (isObject(value)) {
    const type = value.type ?? value.status ?? value.state;
    return typeof type === 'string' ? type : '';
  }
  return '';
}

function threadArrayFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObject(value)) {
    return [];
  }
  if (isObject(value.payload)) {
    const nested = threadArrayFromResponse(value.payload.data ?? value.payload);
    if (nested.length) {
      return nested;
    }
  }
  if (isObject(value.result)) {
    const nested = threadArrayFromResponse(value.result);
    if (nested.length) {
      return nested;
    }
  }
  for (const key of ['data', 'threads', 'items']) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return [];
}

function threadObjectFromResponse(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) {
    return null;
  }
  const payloadValue = isObject(value.payload) ? value.payload : value;
  const data = eventPayloadData({ type: '', payload: payloadValue });
  const source = Object.keys(data).length ? data : value;
  const result = isObject(source.result) ? source.result : source;
  const thread = isObject(result.thread) ? result.thread : result;
  return typeof thread.id === 'string' ? thread : null;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (!isObject(part)) {
        return '';
      }
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.name === 'string' && part.name) {
        return `@${part.name}`;
      }
      if (typeof part.path === 'string' && part.path) {
        return part.path;
      }
      if (typeof part.url === 'string' && part.url) {
        return part.url;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function textFromThreadItem(item: Record<string, unknown>): string {
  const directText = item.text ?? item.message ?? item.summary;
  if (typeof directText === 'string') {
    return directText;
  }
  return textFromContent(item.content);
}

export function parseCodexNativeThread(value: unknown): CodexNativeThread | null {
  const thread = threadObjectFromResponse(value);
  if (!thread) {
    return null;
  }

  const id = stringField(thread, ['id', 'threadId', 'thread_id']);
  if (!id) {
    return null;
  }

  const now = Date.now();
  const name = stringField(thread, ['name', 'title']);
  const preview = stringField(thread, ['preview', 'summary', 'firstMessage', 'first_message']);
  const title = name || preview || id;
  const session = isObject(thread.session) ? thread.session : {};
  const cwd = stringField(thread, ['cwd', 'workingDirectory', 'working_directory', 'path']) || stringField(session, ['cwd', 'workingDirectory', 'working_directory', 'path']);

  return {
    id,
    title,
    preview,
    name,
    status: threadStatusLabel(thread.status),
    archived: booleanField(thread, ['archived'], false),
    createdAt: timestampField(thread, ['createdAt', 'created_at'], now),
    updatedAt: timestampField(thread, ['updatedAt', 'updated_at', 'lastActivityAt', 'last_activity_at'], timestampField(thread, ['createdAt', 'created_at'], now)),
    cwd,
    model: stringField(thread, ['model', 'modelId', 'model_id']),
    sessionId: stringField(thread, ['sessionId', 'session_id']),
    raw: thread,
  };
}

export function parseCodexNativeThreadListResponse(value: unknown): CodexNativeThread[] {
  const threads = threadArrayFromResponse(value);
  const parsed = threads
    .map(parseCodexNativeThread)
    .filter((item): item is CodexNativeThread => Boolean(item));
  const byId = new Map<string, CodexNativeThread>();
  parsed.forEach((thread) => byId.set(thread.id, thread));
  return [...byId.values()];
}

export function parseCodexNativeThreadReadResponse(value: unknown): {
  thread: CodexNativeThread;
  history: CodexThreadHistoryEntry[];
} | null {
  const thread = parseCodexNativeThread(value);
  const rawThread = threadObjectFromResponse(value);
  if (!thread || !rawThread) {
    return null;
  }

  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const history: CodexThreadHistoryEntry[] = [];

  turns.forEach((turn, turnIndex) => {
    if (!isObject(turn)) {
      return;
    }
    const turnId = stringField(turn, ['id', 'turnId', 'turn_id']) || `turn-${turnIndex}`;
    const at = timestampField(turn, ['completedAt', 'completed_at', 'startedAt', 'started_at'], thread.updatedAt);
    const items = Array.isArray(turn.items) ? turn.items : [];
    items.forEach((item, itemIndex) => {
      if (!isObject(item)) {
        return;
      }
      const type = stringField(item, ['type', 'itemType', 'item_type']);
      const text = textFromThreadItem(item).trim();
      if (!text) {
        return;
      }
      const itemId = stringField(item, ['id', 'itemId', 'item_id']) || `${turnId}-${itemIndex}`;
      const outgoing = type === 'userMessage' || type === 'user_message';
      const incoming = type === 'agentMessage' || type === 'agent_message';
      if (!outgoing && !incoming) {
        return;
      }
      history.push({
        id: `native-${thread.id}-${itemId}`,
        kind: outgoing ? 'outgoing' : 'incoming',
        title: outgoing ? 'You' : 'Codex',
        subtitle: text,
        raw: shortJson(item),
        at,
      });
    });
  });

  return { thread, history };
}

export function eventId(event: ServerEvent): string {
  return String(event.event_id ?? event.id ?? createRequestId('event'));
}

export function requestIdFromEvent(event: ServerEvent): string | null {
  const data = eventPayloadData(event);
  const value = data.requestId ?? data.request_id ?? data.permissionId ?? data.permission_id ?? data.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function requestTypeFromEvent(event: ServerEvent): string {
  return event.type;
}

export function isPendingRequestType(type: string): boolean {
  return (
    type.endsWith('.request') ||
    type === 'codex.tool.requestUserInput.request' ||
    type === 'codex.account.chatgptAuthTokens.refresh'
  );
}

export function isApprovalLikeRequest(type: string): boolean {
  return (
    type === 'codex.approval.commandExecution.request' ||
    type === 'codex.approval.fileChange.request' ||
    type === 'codex.approval.permissions.request' ||
    type === 'codex.tool.requestUserInput.request' ||
    type === 'codex.tool.call.request' ||
    type === 'codex.account.chatgptAuthTokens.refresh'
  );
}

export function inferApprovalResponseType(requestType: string): string {
  switch (requestType) {
    case 'codex.approval.commandExecution.request':
      return 'codex.approval.commandExecution.respond';
    case 'codex.approval.fileChange.request':
      return 'codex.approval.fileChange.respond';
    case 'codex.approval.permissions.request':
      return 'codex.approval.permissions.respond';
    case 'codex.tool.requestUserInput.request':
      return 'codex.tool.requestUserInput.respond';
    case 'codex.tool.call.request':
      return 'codex.tool.call.respond';
    case 'codex.mcp.elicitation.request':
      return 'codex.mcp.elicitation.respond';
    case 'codex.account.chatgptAuthTokens.refresh':
      return 'codex.account.chatgptAuthTokens.refresh.respond';
    case 'conversation.permission.request':
      return 'conversation.permission.respond';
    default:
      return 'codex.approval.permissions.respond';
  }
}

export function classifyPendingRequest(event: ServerEvent): PendingRequest | null {
  if (!isPendingRequestType(event.type)) {
    return null;
  }

  const requestId = requestIdFromEvent(event);
  if (!requestId) {
    return null;
  }

  const data = eventPayloadData(event);
  return {
    requestId,
    requestType: event.type,
    title: titleForRequest(event.type, data),
    event,
    data,
  };
}

const MAX_RESOLVED_PENDING_REQUEST_IDS = 512;

export function updatePendingRequestsFromEvent(
  current: PendingRequest[],
  event: ServerEvent,
  resolvedRequestIds: Set<string>,
): PendingRequest[] {
  const data = eventPayloadData(event);
  if (event.type === 'codex.serverRequest.resolved' || event.type === 'permission.resolved') {
    const resolvedId = data.requestId ?? data.request_id ?? data.permissionId;
    if (typeof resolvedId !== 'string' || !resolvedId) {
      return current;
    }
    resolvedRequestIds.add(resolvedId);
    while (resolvedRequestIds.size > MAX_RESOLVED_PENDING_REQUEST_IDS) {
      const oldestId = resolvedRequestIds.values().next().value;
      if (typeof oldestId !== 'string') break;
      resolvedRequestIds.delete(oldestId);
    }
    const next = current.filter((request) => request.requestId !== resolvedId);
    return next.length === current.length ? current : next;
  }

  const request = classifyPendingRequest(event);
  if (!request || resolvedRequestIds.has(request.requestId)) {
    return current;
  }
  const index = current.findIndex((item) => item.requestId === request.requestId);
  if (index === -1) {
    return [request, ...current];
  }
  if (current[index].event === event) {
    return current;
  }
  const next = current.slice();
  next[index] = request;
  return next;
}

export function titleForRequest(type: string, data: Record<string, unknown>): string {
  const requestId = String(data.requestId ?? data.request_id ?? '');
  const base = requestId ? `${requestId} · ` : '';

  switch (type) {
    case 'codex.approval.commandExecution.request':
      return `${base}command approval`;
    case 'codex.approval.fileChange.request':
      return `${base}file approval`;
    case 'codex.approval.permissions.request':
      return `${base}permission approval`;
    case 'codex.tool.requestUserInput.request':
      return `${base}question`;
    case 'codex.tool.call.request':
      return `${base}tool call`;
    case 'codex.account.chatgptAuthTokens.refresh':
      return `${base}token refresh`;
    case 'conversation.permission.request':
      return typeof data.title === 'string' && data.title.trim()
        ? data.title
        : `${base}权限审批`;
    default:
      return `${base}${type}`;
  }
}

export function summarizeEventType(type: string): string {
  if (type.startsWith('codex.local.')) {
    return type.replace('codex.local.', 'local · ');
  }
  if (type.startsWith('codex.cloudTask.')) {
    return type.replace('codex.cloudTask.', 'task · ');
  }
  if (type.startsWith('codex.approval.')) {
    return type.replace('codex.approval.', 'approval · ');
  }
  if (type.startsWith('codex.turn.')) {
    return type.replace('codex.turn.', 'turn · ');
  }
  if (type.startsWith('codex.thread.')) {
    return type.replace('codex.thread.', 'thread · ');
  }
  if (type.startsWith('codex.mcp.')) {
    return type.replace('codex.mcp.', 'mcp · ');
  }
  return type;
}

export function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createMessage(type: string, payload: Record<string, unknown>): SendableMessage {
  return {
    id: createRequestId('msg'),
    type,
    payload,
  };
}

export function sandboxPolicyForMode(mode: string | null | undefined): Record<string, unknown> | undefined {
  switch ((mode ?? '').trim().toLowerCase()) {
    case 'read-only':
    case 'readonly':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
    case 'workspacewrite':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
    case 'dangerfullaccess':
    case 'full-access':
      return { type: 'dangerFullAccess' };
    default:
      return undefined;
  }
}

export function approvalResponsePayload(request: PendingRequest, accepted: boolean): Record<string, unknown> {
  if (request.requestType === 'codex.approval.permissions.request') {
    const requestedPermissions = isObject(request.data.permissions) ? request.data.permissions : {};
    const permissions = accepted ? requestedPermissions : {};

    return {
      permissions,
      scope: 'turn',
      strictAutoReview: false,
    };
  }

  if (
    request.requestType === 'codex.approval.commandExecution.request' ||
    request.requestType === 'codex.approval.fileChange.request'
  ) {
    return {
      decision: accepted ? 'accept' : 'decline',
    };
  }

  if (request.requestType === 'codex.tool.requestUserInput.request') {
    const questions = Array.isArray(request.data.questions) ? request.data.questions : [];
    const answers = questions.reduce<Record<string, { answers: string[] }>>((acc, question) => {
      if (isObject(question) && typeof question.id === 'string' && question.id) {
        acc[question.id] = { answers: accepted ? ['yes'] : ['no'] };
      }
      return acc;
    }, {});

    return {
      answers: Object.keys(answers).length > 0 ? answers : { response: { answers: accepted ? ['yes'] : ['no'] } },
    };
  }

  if (request.requestType === 'codex.tool.call.request') {
    return {
      decision: accepted ? 'accept' : 'decline',
    };
  }

  if (request.requestType === 'codex.mcp.elicitation.request') {
    return {
      action: accepted ? 'accept' : 'decline',
      content: {},
      _meta: null,
    };
  }

  if (request.requestType === 'codex.account.chatgptAuthTokens.refresh') {
    return {
      decision: accepted ? 'accept' : 'decline',
    };
  }

  return {
    decision: accepted ? 'accept' : 'decline',
  };
}

function localSessionPayload(ctx: CommandContext): Record<string, unknown> {
  const workspace = ctx.workspace;
  return {
    codexSessionId: workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
    tenantId: ctx.settings.tenantId,
  };
}

function localCwdPayload(ctx: CommandContext): Record<string, unknown> {
  const workspace = ctx.workspace;
  return {
    codexSessionId: workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
    tenantId: ctx.settings.tenantId,
    cwd: workspace?.path ?? ctx.settings.defaultWorkspacePath,
  };
}

export const COMMAND_PRESETS: CommandPreset[] = [
  {
    group: 'Local session',
    label: 'codex.local.start',
    type: 'codex.local.start',
    description: 'Start a local Codex CLI adapter for the selected workspace.',
    build: (ctx) => ({
      ...localCwdPayload(ctx),
      model: ctx.workspace?.model || ctx.settings.defaultModel || undefined,
      approvalPolicy: ctx.settings.approvalPolicy || undefined,
      sandboxMode: ctx.settings.sandboxMode || undefined,
      configOverrides: {
        reasoningEffort: ctx.workspace?.reasoningEffort || undefined,
      },
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.status',
    type: 'codex.local.status',
    description: 'Read the current local adapter status.',
    build: (ctx) => localSessionPayload(ctx),
  },
  {
    group: 'Local session',
    label: 'codex.local.stop',
    type: 'codex.local.stop',
    description: 'Stop the local adapter.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      force: false,
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.turn',
    type: 'codex.local.turn',
    description: 'Send a new turn to the local adapter.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      threadId: ctx.threadId,
      input: [{ type: 'text', text: ctx.prompt || 'Write a message for Codex.' }],
      collaborationMode: {
        mode: 'default',
        settings: {
          model: ctx.workspace?.model || ctx.settings.defaultModel || undefined,
          reasoningEffort: ctx.workspace?.reasoningEffort || undefined,
          developerInstructions: null,
        },
      },
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.input',
    type: 'codex.local.input',
    description: 'Append text to the active turn.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      threadId: ctx.threadId,
      turnId: ctx.turnId || '',
      input: [{ type: 'text', text: ctx.prompt || 'Continue.' }],
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.steer',
    type: 'codex.local.steer',
    description: 'Steer the active turn with a new input.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      threadId: ctx.threadId,
      turnId: ctx.turnId || '',
      expectedTurnId: ctx.turnId || undefined,
      input: [{ type: 'text', text: ctx.prompt || 'Adjust the plan.' }],
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.interrupt',
    type: 'codex.local.interrupt',
    description: 'Interrupt the active turn.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      threadId: ctx.threadId,
      turnId: ctx.turnId || undefined,
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.replay',
    type: 'codex.local.replay',
    description: 'Replay events after a cursor.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      afterCursor: null,
      limit: 200,
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.attach',
    type: 'codex.local.attach',
    description: 'Attach to an existing session and replay recent events.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      afterCursor: null,
      replayLimit: 200,
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.snapshot',
    type: 'codex.local.snapshot',
    description: 'Request a snapshot of the current local adapter state.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      maxBytes: 65_536,
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.unsupported',
    type: 'codex.local.unsupported',
    description: 'Send a rejected local operation marker.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      operation: 'codex.cloudTask.create',
      reason: 'operation is excluded from local Codex CLI control',
    }),
  },
  {
    group: 'Local session',
    label: 'codex.local.request',
    type: 'codex.local.request',
    description: 'Send an arbitrary local method request.',
    build: (ctx) => ({
      ...localSessionPayload(ctx),
      method: 'thread/start',
      params: {
        threadId: ctx.threadId,
      },
    }),
  },
  {
    group: 'Approvals',
    label: 'codex.local.approval.respond',
    type: 'codex.local.approval.respond',
    description: 'Respond to the selected approval or question request.',
    build: (ctx) => {
      const request = ctx.selectedRequest;
      return {
        ...localSessionPayload(ctx),
        requestId: request?.requestId ?? '',
        responseType: request ? inferApprovalResponseType(request.requestType) : 'codex.approval.permissions.respond',
        response: request ? approvalResponsePayload(request, true) : { decision: 'accept' },
      };
    },
  },
  {
    group: 'Lifecycle',
    label: 'codex.thread.start',
    type: 'codex.thread.start',
    description: 'Start a Codex thread.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        threadId: ctx.threadId,
      },
    }),
  },
  {
    group: 'Lifecycle',
    label: 'codex.turn.start',
    type: 'codex.turn.start',
    description: 'Start a Codex turn.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        threadId: ctx.threadId,
        input: [{ type: 'text', text: ctx.prompt || 'Start the turn.' }],
      },
    }),
  },
  {
    group: 'Lifecycle',
    label: 'codex.turn.steer',
    type: 'codex.turn.steer',
    description: 'Steer a turn from the lifecycle gateway.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId || '',
        expectedTurnId: ctx.turnId || undefined,
        input: [{ type: 'text', text: ctx.prompt || 'Steer the turn.' }],
      },
    }),
  },
  {
    group: 'Lifecycle',
    label: 'codex.turn.interrupt',
    type: 'codex.turn.interrupt',
    description: 'Interrupt a lifecycle turn.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.turnId || undefined,
      },
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.server.listStatus',
    type: 'codex.mcp.server.listStatus',
    description: 'List MCP server status.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {},
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.resource.read',
    type: 'codex.mcp.resource.read',
    description: 'Read an MCP resource.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        uri: ctx.prompt || 'file:///path/to/resource',
      },
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.tool.call',
    type: 'codex.mcp.tool.call',
    description: 'Call an MCP tool.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        name: ctx.prompt || 'tool-name',
        arguments: {},
      },
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.server.refresh',
    type: 'codex.mcp.server.refresh',
    description: 'Refresh MCP servers.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {},
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.oauth.login',
    type: 'codex.mcp.oauth.login',
    description: 'Start an MCP OAuth login flow.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        serverId: ctx.prompt || 'server-id',
      },
    }),
  },
  {
    group: 'MCP',
    label: 'codex.mcp.elicitation.respond',
    type: 'codex.mcp.elicitation.respond',
    description: 'Respond to an MCP elicitation prompt.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      payload: {
        requestId: ctx.selectedRequest?.requestId ?? '',
        action: 'accept',
        content: {},
        _meta: null,
      },
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.create',
    type: 'codex.cloudTask.create',
    description: 'Create a Codex cloud task.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      env_id: ctx.settings.tenantId,
      prompt: ctx.prompt || 'Describe the task.',
      git_ref: 'main',
      qa_mode: false,
      best_of_n: 1,
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.list',
    type: 'codex.cloudTask.list',
    description: 'List Codex cloud tasks.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      env: ctx.settings.tenantId,
      limit: 25,
      cursor: '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.getSummary',
    type: 'codex.cloudTask.getSummary',
    description: 'Get a cloud task summary.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.getDiff',
    type: 'codex.cloudTask.getDiff',
    description: 'Get a cloud task diff.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.getMessages',
    type: 'codex.cloudTask.getMessages',
    description: 'Get cloud task messages.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.getText',
    type: 'codex.cloudTask.getText',
    description: 'Get cloud task text.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.listSiblingAttempts',
    type: 'codex.cloudTask.listSiblingAttempts',
    description: 'List sibling task attempts.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
      turn_id: ctx.turnId || '',
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.applyPreflight',
    type: 'codex.cloudTask.applyPreflight',
    description: 'Run a preflight apply.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
      diff_override: null,
      turn_id: ctx.turnId || '',
      attempt_placement: 0,
    }),
  },
  {
    group: 'Cloud tasks',
    label: 'codex.cloudTask.apply',
    type: 'codex.cloudTask.apply',
    description: 'Apply a cloud task.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      task_id: ctx.selectedRequest?.requestId ?? '',
      diff_override: null,
      turn_id: ctx.turnId || '',
      attempt_placement: 0,
    }),
  },
  {
    group: 'Gateway',
    label: 'codex.gateway.control',
    type: 'codex.gateway.control',
    description: 'Issue a gateway control request.',
    build: (ctx) => ({
      codex_session_id: ctx.workspace?.sessionId ?? `cdxs_${createRequestId('session')}`,
      tenant_id: ctx.settings.tenantId,
      action: 'control',
    }),
  },
];

export function findCommandPreset(type: string): CommandPreset | undefined {
  return COMMAND_PRESETS.find((preset) => preset.type === type);
}

export function presetsByGroup(): Record<string, CommandPreset[]> {
  return COMMAND_PRESETS.reduce<Record<string, CommandPreset[]>>((groups, preset) => {
    if (!groups[preset.group]) {
      groups[preset.group] = [];
    }
    groups[preset.group].push(preset);
    return groups;
  }, {});
}

export function parseSlashCommand(input: string): {
  type: string;
  payload: Record<string, unknown>;
  requestId: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    return null;
  }

  const [command, ...rest] = body.split(/\s+/);
  const tail = rest.join(' ').trim();
  const commandLower = command.toLowerCase();

  if (commandLower === 'help') {
    return {
      type: 'codex.local.unsupported',
      payload: {
        operation: 'help',
        reason: 'open the Commands tab for the full protocol catalog',
      },
      requestId: createRequestId('help'),
    };
  }

  if (
    commandLower === 'approve' ||
    commandLower === 'approval'
  ) {
    const accepted = !/^(deny|decline|reject|no|false)$/i.test(rest[0] ?? 'accept');
    const requestId = rest[1] ?? '';
    return {
      type: 'codex.local.approval.respond',
      requestId: createRequestId('approval'),
      payload: {
        requestId,
        responseType: 'codex.approval.permissions.respond',
        response: {
          decision: accepted ? 'accept' : 'deny',
        },
      },
    };
  }

  if (commandLower === 'start') {
    return {
      type: 'codex.local.start',
      requestId: createRequestId('local-start'),
      payload: {
        cwd: tail || '',
      },
    };
  }

  if (commandLower === 'status') {
    return {
      type: 'codex.local.status',
      requestId: createRequestId('local-status'),
      payload: {},
    };
  }

  if (commandLower === 'stop') {
    return {
      type: 'codex.local.stop',
      requestId: createRequestId('local-stop'),
      payload: {
        force: /true|force|1/i.test(tail),
      },
    };
  }

  if (commandLower === 'turn') {
    return {
      type: 'codex.local.turn',
      requestId: createRequestId('local-turn'),
      payload: {
        text: tail,
      },
    };
  }

  if (commandLower === 'input') {
    return {
      type: 'codex.local.input',
      requestId: createRequestId('local-input'),
      payload: {
        text: tail,
      },
    };
  }

  if (commandLower === 'steer') {
    return {
      type: 'codex.local.steer',
      requestId: createRequestId('local-steer'),
      payload: {
        text: tail,
      },
    };
  }

  if (commandLower === 'interrupt') {
    return {
      type: 'codex.local.interrupt',
      requestId: createRequestId('local-interrupt'),
      payload: {},
    };
  }

  if (commandLower === 'replay') {
    return {
      type: 'codex.local.replay',
      requestId: createRequestId('local-replay'),
      payload: {},
    };
  }

  if (commandLower === 'attach') {
    return {
      type: 'codex.local.attach',
      requestId: createRequestId('local-attach'),
      payload: {},
    };
  }

  if (commandLower === 'snapshot') {
    return {
      type: 'codex.local.snapshot',
      requestId: createRequestId('local-snapshot'),
      payload: {},
    };
  }

  return null;
}

// Keep mobile parity helpers available through the existing protocol barrel.
export {
  buildConversationRenderItems,
  classifyV2ConversationEvent,
  contextUsageFromV2Event,
  conversationFromManifest,
  conversationPreviewText,
  executionGroupId,
  isChatReminderEntry,
  isCollapsibleProgressEntry,
  isLifecycleProgressText,
  isLoopbackHostname,
  isLoopbackUrl,
  isStepProgressEntry,
  isThinkingProgressEntry,
  isVisibleConversationEntry,
  normalizeBackendConnectionProfile,
  normalizeBackendConnectionProfiles,
  normalizeConversationReasoningEffort,
  normalizeConversationRecord,
  normalizeUsageRecords,
  profileFromSettings,
  providerIconFor,
  providerIconMetadata,
  settingsFromProfile,
  usageNumber,
  usageRecordFromEvent,
  usageRecordFromV2Event,
  validateLoopbackUrl,
  workspaceLinkTarget,
  PROVIDER_ICON_METADATA,
  MAX_USAGE_RECORDS,
} from './mobileParity';
export type {
  BackendProfileNormalizeOptions,
  ConversationContextUsage,
  ConversationManifestNormalizeOptions,
  ConversationNormalizeOptions,
  ConversationRecord,
  ConversationRenderItem,
  LoopbackUrlValidation,
  ProviderIconMetadata,
  TimelineEntry,
  UsageNormalizeOptions,
  UsageRecord,
  UsageRecordContext,
  WorkspaceLinkOptions,
  WorkspaceLinkTarget,
} from './mobileParity';

export * from './conversationRuntime';
