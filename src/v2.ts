import { controlFrame } from './conversationCommands';
import { buildHttpUrl, utf8ByteLength } from './todex';
import { ConnectionError } from './connectionError';
import { MetricsCollector, type ConnectionMetrics } from './connectionMetrics';
import { deviceAuthHeaders, deviceAuthQuery, type DeviceIdentity } from './deviceAuth';

/**
 * Client-side guard for `conversation.*` commands sent over /v2/ws. The
 * backend socket accepts up to 8 MiB (legacy chat attachments travel as
 * base64 data URLs without chunking); conversation payloads stay tighter.
 */
export const MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

export type PermissionMode = 'ask' | 'auto' | 'full-access';
export type WorkMode = 'plan' | 'implement';

export type ProviderKind = 'acp' | 'codex' | 'pi' | 'claude-code' | 'grok-build' | 'devin' | 'opencode';

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  acp: 'ACP',
  codex: 'Codex CLI',
  pi: 'Pi',
  'claude-code': 'Claude Code',
  'grok-build': 'Grok Build',
  devin: 'Devin',
  opencode: 'OpenCode',
};

export function providerDisplayName(provider: ProviderKind | string, fallback?: string): string {
  if (provider in PROVIDER_DISPLAY_NAMES) {
    return PROVIDER_DISPLAY_NAMES[provider as ProviderKind];
  }
  return fallback?.trim() || provider;
}

export type PromptSkillRef = {
  resourceId: string;
  name?: string;
};

export type PromptContentRef =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'file'; path: string; name?: string };

export type ProviderCapabilities = {
  nativeResume: boolean;
  cancel: boolean;
  permissions: boolean;
  toolEvents: boolean;
  nativeSkills: boolean;
  nativeMcp: boolean;
  managedMcp: boolean;
  modelSelection: boolean;
  /** Missing on older backends; clients must treat absence as unsupported. */
  imageInput?: boolean;
  imageInputMode?: 'always' | 'model' | 'profile' | 'none';
  streaming?: boolean;
  structuredOutput?: boolean;
  interjection?: boolean;
  steering?: boolean;
  liveConfiguration?: boolean;
  followUpQueue?: boolean;
  /** Session-owned Pi surfaces require explicit support from the connected backend. */
  runtimeStop?: boolean;
  sessionCommands?: boolean;
  extensionUi?: string[];
  extensionMessages?: boolean;
  controlActions?: ConversationControlAction[];
  permissionConfig?: {
    /** Modes supported by the adapter; runtime policy may still reject a mode. */
    modes?: PermissionMode[];
    defaultMode?: PermissionMode;
    supportsPlan?: boolean;
    sandboxModes?: string[];
    approvalPolicies?: string[];
    permissionProfiles?: string[];
    enforcement?: string;
  };
};

export type ConfigValueSource = 'system' | 'workspace' | 'profile' | 'provider' | 'conversation' | 'turn' | 'default';
export type ResolvedConfigValue<T> = { value: T; source: ConfigValueSource; locked?: boolean; overridden?: boolean };

export function resolveConfigValue<T>(
  layers: Partial<Record<ConfigValueSource, T>>,
  order: readonly ConfigValueSource[] = ['turn', 'conversation', 'provider', 'profile', 'workspace', 'system', 'default'],
): ResolvedConfigValue<T> | undefined {
  for (const source of order) {
    if (Object.prototype.hasOwnProperty.call(layers, source)) {
      const value = layers[source];
      if (value !== undefined) return { value, source, overridden: source !== order[order.length - 1] };
    }
  }
  return undefined;
}

export type AgentCompletionReason = 'completed' | 'cancelled' | 'interrupted' | 'failed' | 'approvalRequired' | 'contextExhausted' | 'rateLimited' | 'connectionLost' | 'providerShutdown';
export type ConversationControlAction = 'cancel' | 'interrupt' | 'steer' | 'followUp' | 'retry' | 'resume' | 'fork' | 'compact' | 'stop' | 'queue';
export function conversationControlMethod(action: ConversationControlAction): string {
  return action.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`);
}
export type ContextCompactionStatus = 'idle' | 'recommended' | 'running' | 'completed' | 'failed';
export type ContextCompactionState = {
  status: ContextCompactionStatus;
  usedTokens?: number;
  contextWindow?: number;
  summary?: string;
  updatedAt: string;
  error?: string;
};
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SubagentRun = {
  id: string;
  conversationId: string;
  title: string;
  task: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};
export type MemoryEntry = {
  id: string;
  scope: 'workspace' | 'conversation' | 'user';
  content: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
};
export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WorkflowRun = {
  id: string;
  conversationId: string;
  status: WorkflowRunStatus;
  currentStepId?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};
export type WorkflowStep = {
  id: string;
  workflowId: string;
  title: string;
  status: WorkflowRunStatus;
  dependsOn: string[];
  input?: unknown;
  output?: unknown;
  error?: string;
};
export type DurableToolCheckpoint = {
  id: string;
  conversationId: string;
  toolCallId: string;
  status: 'pending' | 'committed' | 'rolledBack';
  input?: unknown;
  output?: unknown;
  createdAt: string;
  committedAt?: string;
};
export type PluginTrustLevel = 'unknown' | 'review' | 'trusted' | 'blocked';
export type PluginDescriptor = {
  id: string;
  name: string;
  version?: string;
  source: string;
  enabled: boolean;
  trust: PluginTrustLevel;
  permissions: string[];
  reason?: string;
};
export function canInvokePlugin(plugin: Pick<PluginDescriptor, 'enabled' | 'trust'>): boolean {
  return plugin.enabled && plugin.trust === 'trusted';
}

export function contextCompactionStatus(usedTokens: number | undefined, contextWindow: number | undefined): ContextCompactionStatus {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return 'idle';
  return (usedTokens ?? 0) / (contextWindow ?? 1) >= 0.8 ? 'recommended' : 'idle';
}
export type ToolCallStatus = 'queued' | 'streaming' | 'awaitingApproval' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ToolCallState = {
  callId: string;
  name: string;
  argumentsText: string;
  argumentsJson?: unknown;
  resultText?: string;
  resultJson?: unknown;
  stdout?: string;
  stderr?: string;
  status: ToolCallStatus;
  error?: string;
  completionReason?: AgentCompletionReason;
};

export function providerCapabilityMatrix(capabilities: ProviderCapabilities) {
  return {
    resume: capabilities.nativeResume,
    cancel: capabilities.cancel,
    permissions: capabilities.permissions,
    toolCalling: capabilities.toolEvents,
    mcp: capabilities.nativeMcp || capabilities.managedMcp,
    imageInput: capabilities.imageInput === true,
    streaming: capabilities.streaming ?? true,
    structuredOutput: capabilities.structuredOutput ?? capabilities.toolEvents,
    interjection: capabilities.interjection ?? false,
    steering: capabilities.steering ?? false,
    followUpQueue: capabilities.followUpQueue ?? false,
    runtimeStop: capabilities.runtimeStop === true,
    sessionCommands: capabilities.sessionCommands === true,
    extensionUi: capabilities.extensionUi ?? [],
    extensionMessages: capabilities.extensionMessages === true,
    controlActions: capabilities.controlActions ?? [
      ...(capabilities.cancel ? ['cancel' as const] : []),
      ...(capabilities.cancel ? ['interrupt' as const] : []),
      ...(capabilities.followUpQueue === true ? ['queue' as const, 'followUp' as const] : []),
    ],
  } as const;
}

export function supportsControlAction(capabilities: ProviderCapabilities, action: ConversationControlAction): boolean {
  return providerCapabilityMatrix(capabilities).controlActions.includes(action);
}

export type ProviderDescriptor = {
  id: ProviderKind;
  displayName: string;
  available: boolean;
  unavailableReason?: string;
  profiles: string[];
  capabilities: ProviderCapabilities;
  models: ProviderModelDescriptor[];
};

export type ManagedCliProvider = 'codex' | 'pi' | 'claude-code' | 'grok-build' | 'devin' | 'opencode';
export type CliVersionStatus = 'upToDate' | 'updateAvailable' | 'ahead' | 'unknown' | 'notInstalled' | 'external';
export type CliUpgradeStatus = 'running' | 'succeeded' | 'failed';

type CliVersionInfoBase = {
  name: string;
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  status: CliVersionStatus;
  error?: string;
};

export type CliVersionInfo = CliVersionInfoBase & ({
  id: ManagedCliProvider;
  kind: 'managed';
  upgradeSupported: boolean;
} | {
  id: string;
  kind: 'external';
  upgradeSupported: false;
});

export type CliUpgradeOperation = {
  id: string;
  provider: ManagedCliProvider;
  status: CliUpgradeStatus;
  startedAt: string;
  finishedAt?: string;
  previousVersion?: string;
  currentVersion?: string;
  error?: string;
};

export type CliVersionsResponse = {
  clis: CliVersionInfo[];
  checkedAt: string;
  activeOperation?: CliUpgradeOperation;
};

export type ProviderModelDescriptor = {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  contextWindow?: number;
  imageInput?: boolean;
};

export type ProviderModelsResponse = {
  provider: ProviderKind;
  models: ProviderModelDescriptor[];
  source: string;
  fetchedAt: string;
};

export type ProviderImageInputCapability = {
  provider: ProviderKind;
  profile?: string;
  model?: string;
  imageInput: boolean;
  source: string;
  reason?: string;
};

export type ProviderCommandDescriptor = {
  name: string;
  description: string;
  source: string;
  invocation: string;
  argumentHint?: string;
  packageName?: string;
  packageVersion?: string;
};

export type ProviderCommandsResponse = {
  provider: ProviderKind;
  commands: ProviderCommandDescriptor[];
  source: string;
  fetchedAt: string;
  conversationId?: string;
  runtimeId?: string;
  catalogSource?: 'session' | 'discovery';
};

// --- Managed agent provider accounts (cc-switch model) ---

export type ManagedProviderAgent = 'codex' | 'claude-code' | 'pi' | 'opencode';

export const MANAGED_PROVIDER_AGENTS: ManagedProviderAgent[] = ['codex', 'claude-code', 'pi', 'opencode'];

export type AgentProviderProfile = {
  id: string;
  name: string;
  // Opaque per-agent config; secret values arrive masked as "__TODEX_MASKED__".
  settingsConfig: Record<string, unknown>;
  websiteUrl?: string;
  category?: string;
  notes?: string;
  icon?: string;
  iconColor?: string;
  sortIndex?: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentProviderInput = {
  name: string;
  settingsConfig: Record<string, unknown>;
  websiteUrl?: string;
  category?: string;
  notes?: string;
  icon?: string;
  iconColor?: string;
  sortIndex?: number;
};

export type AgentProviderSelection = {
  providerId: string;
  modelId: string | null;
};

export type AgentProviderLive =
  | { kind: 'exclusive'; configured: boolean; config: unknown | null; matchesCurrent: boolean }
  | {
      kind: 'additive';
      providers: Record<string, unknown>;
      selection: AgentProviderSelection | null;
      unmanagedProviders: string[];
    };

export type AgentProviderBucket = {
  agent: ManagedProviderAgent;
  mode: 'exclusive' | 'additive';
  currentProviderId: string | null;
  providers: AgentProviderProfile[];
  live: AgentProviderLive;
};

export type AgentProvidersResponse = {
  agents: Partial<Record<ManagedProviderAgent, AgentProviderBucket>>;
  updatedAt: number;
};

export type CatalogScope = 'user' | 'project';

export type SkillCatalogDescriptor = {
  resourceId: string;
  name: string;
  description: string;
  scope: CatalogScope;
  source: string;
  active: boolean;
  shadowedBy?: string;
  valid: boolean;
  error?: string;
};

export type SkillCatalog = {
  provider: ProviderKind;
  skills: SkillCatalogDescriptor[];
};

export type McpServerCatalogDescriptor = {
  resourceId: string;
  name: string;
  provider: ProviderKind;
  scope: CatalogScope;
  source: string;
  transport: 'stdio' | 'http' | 'unknown';
  enabled: boolean;
  active: boolean;
  shadowedBy?: string;
  tools?: Array<{ name: string; description?: string }>;
  authStatus?: string;
  error?: string;
};

export type McpCatalog = {
  provider: ProviderKind;
  servers: McpServerCatalogDescriptor[];
};

export type ConversationManifest = {
  schemaVersion: number;
  id: string;
  provider: ProviderKind;
  ownerId: string;
  workspace: string;
  workspaceId?: string;
  title?: string;
  providerProfile?: string;
  status: string;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type ExtensionScope = 'session' | 'turn';
export type ProviderRuntimeState = {
  provider: 'pi';
  runtimeId: string;
  status: 'ready' | 'stopped';
  reason?: string;
};
export type ExtensionCustomMessage = {
  role: 'custom';
  customType: string;
  content: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
};
export type ExtensionMessagePayload = {
  provider: 'pi';
  runtimeId: string;
  scope: ExtensionScope;
  messageId: string;
  message: ExtensionCustomMessage;
};
export type ConversationRuntimeStopPayload = { conversationId: string };
export const CONVERSATION_RUNTIME_STOP = 'conversation.runtime.stop' as const;

export type ConversationEvent = {
  schemaVersion: number;
  eventId: string;
  conversationId: string;
  sequence: number;
  time: string;
  type: string;
  normalizedType?: string;
  rawType?: string;
  provider?: ProviderKind | string;
  payload: unknown;
};

export type AgentEventType =
  | 'session.started' | 'session.resumed' | 'turn.started' | 'turn.completed' | 'turn.cancelled' | 'turn.failed'
  | 'assistant.delta' | 'reasoning.delta' | 'tool.started' | 'tool.arguments.delta' | 'tool.awaitingApproval'
  | 'tool.completed' | 'tool.failed' | 'terminal.started' | 'terminal.output' | 'terminal.exited'
  | 'compaction.started' | 'compaction.completed' | 'subagent.started' | 'subagent.completed' | 'protocol.error'
  | 'extension.ui' | 'extension.message' | 'provider.runtime';

export type AgentEventEnvelope = {
  schemaVersion: number;
  eventId: string;
  sequence: number;
  conversationId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  parentItemId?: string;
  provider?: ProviderKind | string;
  rawType: string;
  type: AgentEventType | string;
  timestamp: string;
  payload: unknown;
  raw?: unknown;
};

export type ProviderAdapterContext = {
  conversationId: string;
  provider: ProviderKind | string;
  threadId?: string;
};

export type ProviderAdapter = {
  readonly provider: ProviderKind | string;
  capabilities: ProviderCapabilities;
  normalizeEvent(raw: unknown, context: ProviderAdapterContext): AgentEventEnvelope | null;
  control?(action: ConversationControlAction, payload?: Record<string, unknown>): Record<string, unknown>;
};

export function createGenericProviderAdapter(
  provider: ProviderKind | string,
  capabilities: ProviderCapabilities,
): ProviderAdapter {
  return {
    provider,
    capabilities,
    normalizeEvent(raw, context) {
      const event = normalizeConversationEvent(raw);
      if (!event) return null;
      return toAgentEventEnvelope({ ...event, conversationId: context.conversationId }, provider);
    },
  };
}

/** Resolve known wire aliases before trusting historical normalizedType values.
 * Older servers incorrectly labelled message.completed as turn.completed. */
export function canonicalConversationEventType(event: Pick<ConversationEvent, 'type' | 'normalizedType'>): string {
  const aliases: Record<string, string> = {
    'codex.turn.started': 'turn.started', 'codex.turn.completed': 'turn.completed',
    'conversation.interrupted': 'turn.interrupted', 'conversation.failed': 'turn.failed',
    'message.delta': 'assistant.delta', text_delta: 'assistant.delta',
    'thought.delta': 'reasoning.delta', thinking_delta: 'reasoning.delta',
    'tool.created': 'tool.started', 'tool.result': 'tool.completed', 'tool.error': 'tool.failed',
  };
  if (aliases[event.type]) return aliases[event.type];
  if (/^(?:message|turn|permission|usage|subagent|compaction|memory|extension)\./.test(event.type) || event.type === 'provider.runtime') return event.type;
  return event.normalizedType || event.type;
}

export function normalizeConversationEvent(value: unknown): ConversationEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const eventId = typeof record.eventId === 'string' ? record.eventId : typeof record.event_id === 'string' ? record.event_id : '';
  const conversationId = typeof record.conversationId === 'string' ? record.conversationId : typeof record.conversation_id === 'string' ? record.conversation_id : '';
  const type = typeof record.type === 'string' ? record.type : typeof record.eventType === 'string' ? record.eventType : '';
  const sequence = typeof record.sequence === 'number' && Number.isFinite(record.sequence) ? Math.max(0, Math.floor(record.sequence)) : -1;
  const time = typeof record.time === 'string' ? record.time : typeof record.createdAt === 'string' ? record.createdAt : '';
  if (!eventId || !conversationId || !type || sequence < 0 || !time) return null;
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 1,
    eventId, conversationId, sequence, time, type, payload: record.payload ?? {},
    normalizedType: canonicalConversationEventType({ type, normalizedType: typeof record.normalizedType === 'string' ? record.normalizedType : undefined }),
    ...(typeof record.rawType === 'string' ? { rawType: record.rawType } : {}),
    ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
  };
}

export function toAgentEventEnvelope(event: ConversationEvent, provider?: ProviderKind | string): AgentEventEnvelope {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
  const stringValue = (key: string): string | undefined => typeof payload[key] === 'string' ? payload[key] as string : undefined;
  const rawType = event.rawType ?? stringValue('providerMethod') ?? event.type;
  const resolvedProvider = event.provider ?? provider;
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    sequence: event.sequence,
    conversationId: event.conversationId,
    threadId: stringValue('threadId') ?? stringValue('thread_id'),
    turnId: stringValue('turnId') ?? stringValue('turn_id'),
    itemId: stringValue('itemId') ?? stringValue('item_id'),
    parentItemId: stringValue('parentItemId') ?? stringValue('parent_item_id'),
    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
    rawType,
    type: canonicalConversationEventType(event),
    timestamp: event.time,
    payload: event.payload,
    raw: event.payload,
  };
}

export type ConversationReplay = {
  conversationId: string;
  fromSequence: number;
  nextSequence: number;
  hasMore: boolean;
  events: ConversationEvent[];
};

export type V2Message = {
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type V2ApiOptions = {
  serverUrl: string;
  authToken?: string;
  /** Paired device identity; every request is signed `todex.device-auth.v1`. */
  device?: DeviceIdentity | null;
  fetchImpl?: typeof fetch;
  timeout?: number;
};

export type CreateConversationInput = {
  provider: ProviderKind;
  workspace: string;
  title?: string;
  providerProfile?: string;
};

export type GitAction = 'initial' | 'commit' | 'commit-push' | 'push';

export type GitFileChange = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

export type GitRepositorySummary = {
  path: string;
  name: string;
  branch: string;
  files: GitFileChange[];
  additions: number;
  deletions: number;
  ahead?: number;
  initialEligible: boolean;
  error?: string;
  filesTruncated?: boolean;
};

export type GitScanResponse = {
  repositories: GitRepositorySummary[];
};

export type GitRunRequest = {
  workspacePath: string;
  action: GitAction;
  message?: string;
  includeUnstaged?: boolean;
};

export type GitRunResponse = {
  repositoryPath: string;
  action: GitAction;
  output: string;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseV2Message(raw: string | ArrayBuffer): V2Message | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as unknown;
    const object = jsonObject(parsed);
    return typeof object.type === 'string' ? {
      id: typeof object.id === 'string' ? object.id : undefined,
      type: object.type,
      payload: jsonObject(object.payload),
    } : null;
  } catch {
    return null;
  }
}

export function buildV2WebSocketUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/+$/, '');
  const url = normalized.startsWith('ws://') || normalized.startsWith('wss://')
    ? new URL('/v2/ws', normalized)
    : new URL('/v2/ws', normalized.startsWith('https://')
      ? normalized.replace(/^https:\/\//i, 'wss://')
      : normalized.replace(/^http:\/\//i, 'ws://'));
  return url.toString();
}

export type V2WebSocketUrlOptions = {
  /** Raw pairing-crypto query string (e.g. `enc=x25519&client_key=...`). */
  cryptoQueryString?: string;
  /** Bearer token; browsers cannot set WebSocket headers, so it rides as `access_token`. */
  authToken?: string;
  /** Paired device identity; browsers cannot set WebSocket headers, so the
   * credential rides as a signed query covering the crypto parameters. */
  device?: DeviceIdentity | null;
};

export function buildV2WebSocketUrlWithOptions(
  serverUrl: string,
  options: V2WebSocketUrlOptions = {},
): string {
  const url = new URL(buildV2WebSocketUrl(serverUrl));
  if (options.cryptoQueryString) {
    const query = options.cryptoQueryString.replace(/^\?/, '');
    for (const [key, value] of new URLSearchParams(query)) {
      url.searchParams.set(key, value);
    }
  }
  if (options.authToken) {
    url.searchParams.set('access_token', options.authToken);
  }
  if (options.device) {
    const signed = deviceAuthQuery(
      options.device,
      'GET',
      url.pathname,
      url.search.replace(/^\?/, ''),
    );
    for (const [key, value] of Object.entries(signed)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function buildV2WebSocketUrlWithToken(serverUrl: string, authToken?: string): string {
  return buildV2WebSocketUrlWithOptions(serverUrl, { authToken });
}

export class V2ApiClient {
  private readonly serverUrl: string;
  private readonly authToken: string;
  private readonly device: DeviceIdentity | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;

  constructor(options: V2ApiOptions) {
    this.serverUrl = options.serverUrl;
    this.authToken = options.authToken ?? '';
    this.device = options.device ?? null;
    // Browser fetch requires its Window receiver when called outside `window`.
    this.fetchImpl = options.fetchImpl ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);
    this.timeout = options.timeout ?? 30000;
  }

  async listProviders(): Promise<{ providers: ProviderDescriptor[] }> {
    return this.request('/v2/providers');
  }

  async listCliVersions(): Promise<CliVersionsResponse> {
    return this.request('/v2/providers/versions');
  }

  async upgradeCli(provider: ManagedCliProvider): Promise<CliUpgradeOperation> {
    return this.request(`/v2/providers/${encodeURIComponent(provider)}/upgrade`, { method: 'POST' });
  }

  async getCliUpgrade(operationId: string): Promise<CliUpgradeOperation> {
    return this.request(`/v2/providers/upgrades/${encodeURIComponent(operationId)}`);
  }

  async listProviderModels(provider: ProviderKind, workspace: string): Promise<ProviderModelsResponse> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/providers/models?${query}`);
  }

  async getProviderImageInput(
    provider: ProviderKind,
    workspace: string,
    profile?: string,
    model?: string,
  ): Promise<ProviderImageInputCapability> {
    const query = new URLSearchParams({ provider, workspace });
    if (profile) query.set('profile', profile);
    if (model) query.set('model', model);
    return this.request(`/v2/providers/image-input?${query}`);
  }

  async listProviderCommands(provider: ProviderKind, workspace: string, conversationId?: string): Promise<ProviderCommandsResponse> {
    const query = new URLSearchParams({ provider, workspace });
    if (conversationId) query.set('conversationId', conversationId);
    return this.request(`/v2/providers/commands?${query}`);
  }

  async listAgentProviders(agent?: ManagedProviderAgent): Promise<AgentProvidersResponse> {
    const query = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return this.request(`/v2/agent-providers${query}`);
  }

  async getAgentProviderLive(agent: ManagedProviderAgent): Promise<AgentProviderLive> {
    return this.request(`/v2/agent-providers/${encodeURIComponent(agent)}/live`);
  }

  async upsertAgentProvider(
    agent: ManagedProviderAgent,
    id: string,
    input: AgentProviderInput,
  ): Promise<AgentProviderBucket> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  async deleteAgentProvider(agent: ManagedProviderAgent, id: string): Promise<void> {
    await this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  async activateAgentProvider(
    agent: ManagedProviderAgent,
    id: string,
    modelId?: string,
  ): Promise<AgentProviderBucket> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/${encodeURIComponent(id)}/activate`,
      { method: 'POST', body: JSON.stringify(modelId ? { modelId } : {}) },
    );
  }

  async importLiveAgentProvider(
    agent: ManagedProviderAgent,
    id: string,
    name?: string,
  ): Promise<AgentProviderBucket> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/import-live`,
      { method: 'POST', body: JSON.stringify({ id, name }) },
    );
  }

  async listAgentProviderModels(
    agent: ManagedProviderAgent,
    id: string,
  ): Promise<{ models: Array<{ id: string; name: string }> }> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/${encodeURIComponent(id)}/models`,
    );
  }

  async listSkillCatalog(provider: ProviderKind, workspace: string): Promise<SkillCatalog> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills?${query}`);
  }

  async getSkillResource(provider: ProviderKind, workspace: string, resourceId: string): Promise<{ resourceId: string; content: string }> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/${encodeURIComponent(resourceId)}?${query}`);
  }

  async listMcpCatalog(provider: ProviderKind, workspace: string): Promise<McpCatalog> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/mcp?${query}`);
  }

  async listWorkspaceDirectories(path?: string): Promise<{ root: string; current: string; parent: string | null; entries: Array<{ name: string; path: string; kind: 'directory' }> }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request(`/v2/workspace/directories${query}`);
  }

  async listWorkspaceEntries(cwd: string, query = '', limit = 40): Promise<{ entries: Array<{ name: string; path: string; kind: 'directory' | 'file' }> }> {
    const params = new URLSearchParams({ cwd, query, limit: String(limit) });
    return this.request(`/v2/workspace/entries?${params}`);
  }

  async readWorkspaceFile(path: string): Promise<{ name: string; path: string; mimeType: string; sizeBytes: number; text?: string; dataUrl?: string }> {
    return this.request(`/v2/workspace/file?path=${encodeURIComponent(path)}`);
  }

  async saveWorkspaceFile(path: string, text: string, expectedText: string): Promise<{ saved: boolean }> {
    return this.request('/v2/workspace/file', { method: 'PUT', body: JSON.stringify({ path, text, expectedText }) });
  }

  async fetchBrowser(url: string): Promise<{ url: string; status: number; contentType: string; body: string }> {
    return this.request('/v2/browser/fetch', { method: 'POST', body: JSON.stringify({ url }) });
  }

  async scanGit(workspacePath: string): Promise<GitScanResponse> {
    const query = new URLSearchParams({ workspacePath });
    return this.request(`/v2/git/scan?${query}`);
  }

  async runGit(request: GitRunRequest): Promise<GitRunResponse> {
    return this.request('/v2/git/run', { method: 'POST', body: JSON.stringify(request) });
  }

  async listConversations(): Promise<{ conversations: ConversationManifest[] }> {
    return this.request('/v2/conversations');
  }

  async updateConversation(id: string, input: { title?: string; archived?: boolean }): Promise<ConversationManifest> {
    return this.request(`/v2/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request(`/v2/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationManifest> {
    return this.request('/v2/conversations', { method: 'POST', body: JSON.stringify(input) });
  }

  async getConversation(id: string): Promise<ConversationManifest> {
    return this.request(`/v2/conversations/${encodeURIComponent(id)}`);
  }

  async replayEvents(id: string, afterSequence = 0, limit = 200, detail: 'full' | 'summary' = 'full'): Promise<ConversationReplay> {
    const query = new URLSearchParams({ afterSequence: String(afterSequence), limit: String(limit) });
    // `summary` folds process-only events down to detailStub markers; clients
    // fetch the full payloads for a sequence range when a group is expanded.
    if (detail !== 'full') query.set('detail', detail);
    return this.request(`/v2/conversations/${encodeURIComponent(id)}/events?${query}`);
  }

  async prompt(
    id: string,
    text: string,
    model?: string,
    skills?: PromptSkillRef[],
    reasoningEffort?: string,
    content?: PromptContentRef[],
  ): Promise<{ conversationId: string; turnId: string }> {
    const body: Record<string, unknown> = { text };
    if (model) body.model = model;
    if (skills?.length) body.skills = skills;
    if (reasoningEffort?.trim()) body.reasoningEffort = reasoningEffort.trim();
    if (content?.length) body.content = content;
    return this.request(`/v2/conversations/${encodeURIComponent(id)}/prompt`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }

  async cancel(id: string): Promise<{ conversationId: string; accepted: boolean }> {
    return this.control(id, 'cancel');
  }

  async control(id: string, action: ConversationControlAction, payload: Record<string, unknown> = {}): Promise<{ conversationId: string; accepted: boolean }> {
    if (action !== 'cancel' && action !== 'interrupt') {
      throw new Error('This control requires the WebSocket command channel.');
    }
    const path = action;
    return this.request(`/v2/conversations/${encodeURIComponent(id)}/${path}`, {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  async respondPermission(id: string, permissionId: string, decision: Record<string, unknown>): Promise<void> {
    await this.request(`/v2/conversations/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST', body: JSON.stringify(decision),
    });
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (init.body) headers.set('Content-Type', 'application/json');
      if (this.authToken) headers.set('Authorization', `Bearer ${this.authToken}`);
      if (this.device) {
        const body = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array();
        for (const [name, value] of Object.entries(
          deviceAuthHeaders(this.device, init.method ?? 'GET', pathname, body),
        )) {
          headers.set(name, value);
        }
      }

      const response = await this.fetchImpl(buildHttpUrl(this.serverUrl, pathname), {
        ...init,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const backendError = await response.json().catch(() => null) as {
          code?: unknown;
          message?: unknown;
        } | null;
        const backendCode = typeof backendError?.code === 'string' ? backendError.code : undefined;
        const backendMessage = typeof backendError?.message === 'string' ? backendError.message : undefined;
        if (response.status === 401 || backendCode === 'UNAUTHENTICATED' || backendCode === 'UNAUTHORIZED') {
          throw ConnectionError.authenticationFailed(response.status);
        }
        throw ConnectionError.apiRequestFailed(
          response.status,
          backendCode,
          backendMessage,
        );
      }

      return await response.json() as T;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof ConnectionError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw ConnectionError.timeout(`Request timeout after ${this.timeout}ms`);
      }

      // 网络错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage?.toLowerCase().includes('network') ||
          errorMessage?.toLowerCase().includes('fetch')) {
        throw ConnectionError.networkOffline(errorMessage);
      }

      throw error;
    }
  }
}

export type V2SocketOptions = {
  serverUrl: string;
  authToken?: string;
  /** Paired device identity; credentials ride the signed WS query. */
  device?: DeviceIdentity | null;
  WebSocketImpl?: typeof WebSocket;
  /** Return a promise for asynchronous projection; cursor advances only after success. */
  onEvent?: (event: ConversationEvent) => unknown;
  onResult?: (message: V2Message) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error') => void;
  connectionTimeout?: number;
  heartbeatInterval?: number;
  maxMissedHeartbeats?: number;
};

type Subscription = { afterSequence: number; limit: number };

export class V2ConversationSocket {
  private readonly options: V2SocketOptions;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly eventApplications = new Map<string, Promise<void>>();
  private readonly failedApplications = new Set<string>();
  private socket: WebSocket | null = null;
  private nextId = 1;
  private closedExplicitly = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Pings sent but not yet answered. Size is the missed-heartbeat count. */
  private pendingPingIds = new Set<string>();
  private readonly connectionTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly maxMissedHeartbeats: number;
  private netInfoUnsubscribe?: () => void;
  private wasConnected = false;
  private metrics = new MetricsCollector();

  constructor(options: V2SocketOptions) {
    this.options = options;
    this.connectionTimeout = options.connectionTimeout ?? 10000;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.maxMissedHeartbeats = options.maxMissedHeartbeats ?? 3;
  }

  getMetrics(): Readonly<ConnectionMetrics> {
    return this.metrics.getMetrics();
  }

  connect(): void {
    this.closedExplicitly = false;
    this.options.onStatus?.('connecting');
    const WebSocketImpl = this.options.WebSocketImpl ?? WebSocket;
    const url = buildV2WebSocketUrlWithOptions(this.options.serverUrl, {
      authToken: this.options.authToken,
      device: this.options.device,
    });
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url, this.options.authToken
        ? { headers: { Authorization: `Bearer ${this.options.authToken}` } } as never : undefined);
    } catch {
      // Browser WebSocket implementations reject React Native's header options.
      socket = new WebSocketImpl(url);
    }
    this.socket = socket;
    this.eventApplications.clear();
    this.failedApplications.clear();

    // 连接超时检测
    this.connectionTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        this.options.onError?.(ConnectionError.connectionTimeout());
        socket.close();
      }
    }, this.connectionTimeout);

    // 网络状态监听 (仅在React Native环境)
    if (typeof navigator !== 'undefined' && 'product' in navigator) {
      this.setupNetworkListener();
    }

    socket.onopen = () => {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.reconnectDelayMs = 1000;
      this.metrics.onConnect();
      this.options.onStatus?.('open');
      this.startHeartbeat();
      for (const [conversationId, subscription] of this.subscriptions) {
        this.send('conversation.subscribe', { conversationId, afterSequence: subscription.afterSequence, limit: subscription.limit });
      }
    };
    socket.onmessage = (message) => {
      if (this.socket === socket) this.handleMessage(typeof message.data === 'string' || message.data instanceof ArrayBuffer ? message.data : String(message.data));
    };
    socket.onerror = () => {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.stopHeartbeat();
      this.options.onStatus?.('error');
      const error = new Error('TodeX v2 WebSocket error');
      this.metrics.onError('websocket_error', error.message);
      this.options.onError?.(error);
    };
    socket.onclose = () => {
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.socket = null;
      this.stopHeartbeat();
      this.options.onStatus?.('closed');
      if (!this.closedExplicitly && !this.reconnectTimer) {
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      }
    };
  }

  close(): void {
    this.closedExplicitly = true;
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    if (this.netInfoUnsubscribe) {
      this.netInfoUnsubscribe();
      this.netInfoUnsubscribe = undefined;
    }
    this.socket?.close();
    this.socket = null;
  }

  subscribe(conversationId: string, afterSequence = 0, limit = 200): void {
    const current = this.subscriptions.get(conversationId);
    this.subscriptions.set(conversationId, { afterSequence: Math.max(afterSequence, current?.afterSequence ?? 0), limit });
    this.send('conversation.subscribe', { conversationId, afterSequence, limit });
  }

  sendPrompt(
    conversationId: string,
    text: string,
    model?: string,
    skills?: PromptSkillRef[],
    reasoningEffort?: string,
    content?: PromptContentRef[],
  ): void {
    this.send('conversation.prompt', {
      conversationId,
      text,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(content?.length ? { content } : {}),
    });
  }
  cancel(conversationId: string): void { this.send('conversation.cancel', { conversationId }); }
  control(conversationId: string, action: ConversationControlAction, payload: Record<string, unknown> = {}): void {
    const frame = controlFrame(action, conversationId, payload);
    this.send(frame.type, frame.payload);
  }
  respondPermission(conversationId: string, permissionId: string, decision: Record<string, unknown>): void {
    this.send('conversation.permission.respond', { conversationId, permissionId, decision });
  }
  ping(): void {
    const id = this.send('server.ping', {});
    if (id) this.pendingPingIds.add(id);
  }

  acknowledge(conversationId: string, sequence: number): void {
    const current = this.subscriptions.get(conversationId);
    if (current && sequence > current.afterSequence) current.afterSequence = sequence;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      // Only an unanswered ping counts as missed. Incrementing before sending
      // would also count intervals where `send` bailed out, which says nothing
      // about the link.
      if (this.pendingPingIds.size >= this.maxMissedHeartbeats) {
        this.options.onError?.(ConnectionError.heartbeatTimeout());
        this.socket.close();
        this.stopHeartbeat();
        return;
      }

      this.ping();
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingPingIds.clear();
  }

  /** Returns the id the message was sent under, or null if it never left. */
  private send(type: string, payload: Record<string, unknown>): string | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return null;

    const id = `v2-${this.nextId++}`;
    const message = JSON.stringify({ id, type, payload });

    // 消息大小检查：后端按字节计，String.length 是 UTF-16 码元数
    const size = utf8ByteLength(message);
    if (size > MAX_MESSAGE_SIZE) {
      const error = ConnectionError.messageTooLarge(size, MAX_MESSAGE_SIZE);
      this.metrics.onError(error.type, error.message);
      this.options.onError?.(error);
      return null;
    }

    this.socket.send(message);
    this.metrics.onMessageSent();
    return id;
  }

  private handleMessage(raw: string | ArrayBuffer): void {
    this.metrics.onMessageReceived();

    const message = parseV2Message(raw);
    if (!message) {
      const error = new Error('Invalid TodeX v2 WebSocket message');
      this.metrics.onError('invalid_message', error.message);
      this.options.onError?.(error);
      return;
    }
    // 只有对 ping 的应答才算心跳存活。任意入站消息都重置计数的话，
    // 服务端流式推送期间上行链路已死也检测不到——恰好是最需要心跳的场景。
    // 应答不区分成败：对 ping 的 server.error 同样证明双向链路是通的。
    if (message.id && this.pendingPingIds.delete(message.id)) {
      return;
    }
    if (message.type === 'conversation.event') {
      const payload = message.payload ?? {};
      const event = payload as unknown as ConversationEvent;
      if (typeof event.conversationId === 'string' && Number.isInteger(event.sequence)) {
        this.applyEventBeforeAcknowledging(event);
      }
    } else if (message.type === 'server.error') {
      // 后端在 payload.code 里给出结构化错误码（PROVIDER_UNAVAILABLE 等），
      // 只取 message 会让"provider 未安装"和"内部错误"在 UI 上无法区分。
      const code = typeof message.payload?.code === 'string' ? message.payload.code : '';
      const detail = String(message.payload?.message ?? 'TodeX v2 server error');
      const errorMsg = code ? `[${code}] ${detail}` : detail;
      this.metrics.onError('server_error', errorMsg);
      this.options.onError?.(new Error(errorMsg));
    } else {
      this.options.onResult?.(message);
    }
  }

  private applyEventBeforeAcknowledging(event: ConversationEvent): void {
    const apply = this.options.onEvent;
    const socket = this.socket;
    if (!apply || !socket) return;
    const conversationId = event.conversationId;
    const previous = this.eventApplications.get(conversationId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      if (this.socket !== socket || this.failedApplications.has(conversationId)) return;
      try {
        await apply(event);
        if (this.socket === socket) this.acknowledge(conversationId, event.sequence);
      } catch (error) {
        if (this.socket !== socket) return;
        this.failedApplications.add(conversationId);
        const failure = error instanceof Error ? error : new Error(String(error));
        this.metrics.onError('event_application_failed', failure.message);
        this.options.onError?.(failure);
        // Reconnect from the last successfully projected event. Later events
        // queued on this socket must not acknowledge over the failed event.
        socket.close();
      }
    });
    this.eventApplications.set(conversationId, pending);
    void pending.then(() => {
      if (this.eventApplications.get(conversationId) === pending) this.eventApplications.delete(conversationId);
    });
  }

  private async setupNetworkListener(): Promise<void> {
    try {
      const NetInfo = await import('@react-native-community/netinfo');

      this.netInfoUnsubscribe = NetInfo.default.addEventListener(state => {
        const isConnected = state.isConnected === true && state.isInternetReachable !== false;

        if (!this.wasConnected && isConnected) {
          // 网络恢复
          if (this.socket?.readyState !== WebSocket.OPEN && !this.closedExplicitly) {
            console.log('[V2Socket] Network restored, reconnecting');
            this.connect();
          }
        } else if (this.wasConnected && !isConnected) {
          // 网络断开
          console.log('[V2Socket] Network lost');
          this.options.onStatus?.('error');
        }

        this.wasConnected = isConnected;
      });
    } catch (error) {
      // NetInfo不可用（Web环境），忽略
      console.log('[V2Socket] NetInfo not available, skipping network listener');
    }
  }
}
