import { ConnectionError } from './connectionError';
import { deviceAuthQuery, type DeviceIdentity } from './deviceAuth';
import { createSecureTransport, deviceRequestSigner, type SecureTransport } from './secureTransport';
import type { TransportEncryptionProtocol } from './transportCrypto';
import type {
  FtpSite,
  FtpSiteInput,
  ManagedHost,
  OpenRemoteConnectionInput,
  RemoteConnection,
  RemoteEntriesResponse,
  RemoteFile,
  SshHost,
  SshHostImportResult,
  SshHostsResponse,
  SshKey,
  SshKeyGenerateInput,
  SshKeyImportInput,
  SshKeysResponse,
  SshTestResult,
} from './ssh';
import type { AgentBrowserProfile, AgentBrowserProfiles, AgentComputerPermission, AgentDesktopSettings, AgentShot, ComputerFrame } from './agentDesktop';

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
  /** The daemon holds follow-ups for this provider (`conversation.queue.*`). */
  backendQueue?: boolean;
  /** `conversation.queue.pause` / `.take` and `add` with `paused` (user-held pause). */
  backendQueueControl?: boolean;
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
  /** Provider that reported the run (claude-code, codex, grok-build, ...). */
  provider?: string;
  /** Parent thread/session/turn the provider attributes the run to. */
  parentId?: string;
  /** TodeX turn the run was reported under. */
  turnId?: string;
  /** Native item that spawned the run — e.g. the Task tool_use id — so the
   * timeline tool card and the panel entry describe the same run. */
  providerItemId?: string;
  /** Provider-side agent kind (Explore, local_agent, sender tool name, ...). */
  agentKind?: string;
  /** Provider-side agent identity (Claude agent-<id> transcript, ...). */
  agentId?: string;
  /** Provider-written output/transcript path when one exists. */
  outputFile?: string;
  usage?: Record<string, number>;
  /** Raw provider metadata kept for the detail view. */
  metadata?: Record<string, unknown>;
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
    backendQueue: capabilities.backendQueue === true,
    backendQueueControl: capabilities.backendQueueControl === true,
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
export type CliOperationAction = 'install' | 'upgrade';

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
  /** Missing on older backends; clients must treat absence as unsupported. */
  installSupported?: boolean;
} | {
  id: string;
  kind: 'external';
  upgradeSupported: false;
  installSupported?: false;
});

export type CliUpgradeOperation = {
  id: string;
  provider: ManagedCliProvider;
  /** Missing on older backends, which only upgrade. */
  action?: CliOperationAction;
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

export type QuotaWindow = {
  id: string;
  /** 0–100 percentage used within the window, when the provider reports one. */
  usedPercent?: number;
  /** Unix seconds when the window resets. */
  resetsAt?: number;
  durationMins?: number;
};

export type ProviderQuotaState = 'ok' | 'idle' | 'unavailable' | 'unsupported';

/** Account-level plan quota; distinct from per-turn `usage` accounting. */
export type ProviderQuotaSnapshot = {
  provider: string;
  scope: 'account';
  state: ProviderQuotaState;
  /** Unix milliseconds of the daemon's newest snapshot. */
  fetchedAt?: number;
  planType?: string;
  windows?: QuotaWindow[];
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | number | null };
  buckets?: Record<string, unknown>;
  /** Why the snapshot is idle/unavailable/unsupported. */
  reason?: string;
  raw?: unknown;
};

export type ProviderQuotasResponse = {
  providers: Record<string, ProviderQuotaSnapshot>;
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
  /** Model family (e.g. "opus", "sonnet") used to group versions under one menu entry. */
  family?: string;
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

export type ManagedProviderAgent = 'codex' | 'claude-code' | 'grok-build' | 'pi' | 'opencode';

export const MANAGED_PROVIDER_AGENTS: ManagedProviderAgent[] = ['codex', 'claude-code', 'grok-build', 'pi', 'opencode'];

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

export const AGENT_PROVIDER_TRANSFER_FORMAT = 'todex.agent-providers';

/** One provider in an export file; secrets are in clear, unlike list responses. */
export type AgentProviderTransferItem = AgentProviderInput & { id: string };

/** A per-agent provider export, and the body the import route accepts. */
export type AgentProviderTransfer = {
  format: typeof AGENT_PROVIDER_TRANSFER_FORMAT;
  version: number;
  agent: ManagedProviderAgent;
  exportedAt: number;
  providers: AgentProviderTransferItem[];
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
  /** End-to-end encrypted title (docs/history-encryption.md §3.2); `title`
   * is empty then. Decrypt with HistoryDecryptor.decryptTitle. */
  titleEnc?: { kid: string; ct: string };
  providerProfile?: string;
  status: string;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Stored before history became end-to-end encrypted: readable, archivable
   * and deletable, but every write fails with HISTORY_READ_ONLY. Omitted
   * when false. */
  legacyPlaintext?: boolean;
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
  | 'compaction.started' | 'compaction.completed' | 'protocol.error'
  | 'subagent.started' | 'subagent.updated' | 'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'
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

/** Result of `POST /v2/conversations/{id}/cancel` and `conversation.cancel`. */
export type ConversationCancelResult = {
  conversationId: string;
  accepted: boolean;
  /** False when the named `turnId` was not the active turn; nothing stopped. */
  cancelled?: boolean;
  /** The turn actually running when `cancelled` is false, or null when idle. */
  activeTurnId?: string | null;
};

export type ConversationReplay = {
  conversationId: string;
  fromSequence: number;
  nextSequence: number;
  hasMore: boolean;
  events: ConversationEvent[];
  /** Sealed-segment ciphertext frames referenced by `payload.$enc.fr`
   * (history e2e, §5.3); consumed by HistoryDecryptor.decryptPage. */
  frames?: Record<string, unknown>;
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
  /**
   * Transport every request goes through (desktop/web pass the cached
   * per-profile instance). Without it one is built from `serverUrl`,
   * `device` and the pinned key below: a pinned key tunnels through
   * `/v2/sealed`, no key is plaintext on loopback and refused elsewhere.
   */
  transport?: SecureTransport;
  encryptionProtocol?: TransportEncryptionProtocol;
  encryptionPublicKey?: string;
  /** Whether device pairing verified the pinned key; an unverified pin is refused. */
  transportVerified?: boolean;
  /** Only used when no `transport` is given. */
  fetchImpl?: typeof fetch;
  timeout?: number;
  /** Declare `historyEncryption=1` on history reads: this client decrypts
   * `$enc` payloads (§5.4). An e2e backend rejects history reads without it. */
  historyEncryption?: boolean;
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

/** Value a client declares as `historyEncryption` (WS handshake query,
 * history page query, subscribe payload) when it decrypts `$enc` payloads
 * (TodeX_backend docs/history-encryption.md §5.4). */
export const HISTORY_ENCRYPTION_CAPABILITY = 1;

/** Plaintext (loopback-only) WebSocket URL; transport v2 sockets are opened
 * by `SecureTransport.openSocket`. */
export type V2WebSocketUrlOptions = {
  /** Bearer token; browsers cannot set WebSocket headers, so it rides as `access_token`. */
  authToken?: string;
  /** Paired device identity; browsers cannot set WebSocket headers, so the
   * credential rides as a signed query. */
  device?: DeviceIdentity | null;
  /** Declare end-to-end history support in the handshake (§5.4). */
  historyEncryption?: boolean;
};

export function buildV2WebSocketUrlWithOptions(
  serverUrl: string,
  options: V2WebSocketUrlOptions = {},
): string {
  const url = new URL(buildV2WebSocketUrl(serverUrl));
  if (options.historyEncryption) {
    url.searchParams.set('historyEncryption', String(HISTORY_ENCRYPTION_CAPABILITY));
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

function parseErrorBody(body: Uint8Array): { code?: unknown; message?: unknown } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return value && typeof value === 'object' ? value as { code?: unknown; message?: unknown } : null;
  } catch {
    return null;
  }
}

export class V2ApiClient {
  private readonly authToken: string;
  private readonly transport: SecureTransport;
  private readonly timeout: number;
  private readonly historyEncryption: boolean;

  constructor(options: V2ApiOptions) {
    this.authToken = options.authToken ?? '';
    const device = options.device ?? null;
    this.transport = options.transport ?? createSecureTransport({
      profile: {
        serverUrl: options.serverUrl,
        encryptionProtocol: options.encryptionProtocol ?? 'none',
        encryptionPublicKey: options.encryptionPublicKey ?? '',
        transportVerified: options.transportVerified === true,
      },
      fetchImpl: options.fetchImpl,
      signer: device ? deviceRequestSigner(device) : null,
    });
    this.timeout = options.timeout ?? 30000;
    this.historyEncryption = options.historyEncryption === true;
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

  async installCli(provider: ManagedCliProvider): Promise<CliUpgradeOperation> {
    return this.request(`/v2/providers/${encodeURIComponent(provider)}/install`, { method: 'POST' });
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

  async getProviderQuotas(): Promise<ProviderQuotasResponse> {
    return this.request('/v2/providers/quota');
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

  async exportAgentProviders(agent: ManagedProviderAgent): Promise<AgentProviderTransfer> {
    return this.request(`/v2/agent-providers/${encodeURIComponent(agent)}/export`);
  }

  /** Upserts every provider in the file by id; others stay, current is kept. */
  async importAgentProviders(
    agent: ManagedProviderAgent,
    transfer: AgentProviderTransfer,
  ): Promise<AgentProviderBucket> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/import`,
      { method: 'POST', body: JSON.stringify(transfer) },
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

  async previewAgentProviderModels(
    agent: ManagedProviderAgent,
    id: string,
    settingsConfig: Record<string, unknown>,
  ): Promise<{ models: Array<{ id: string; name: string }> }> {
    return this.request(
      `/v2/agent-providers/${encodeURIComponent(agent)}/${encodeURIComponent(id)}/models`,
      { method: 'POST', body: JSON.stringify({ settingsConfig }) },
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
    if (this.historyEncryption) query.set('historyEncryption', String(HISTORY_ENCRYPTION_CAPABILITY));
    return this.request(`/v2/conversations/${encodeURIComponent(id)}/events?${query}`);
  }

  /** Reverse pagination for lazy history loading: returns the newest events
   * with `sequence <= beforeSequence` in ascending order; `hasMore` reports
   * whether earlier events remain. Page back with
   * `beforeSequence = firstReturnedSequence - 1`. */
  async replayEventsBefore(id: string, beforeSequence: number, limit = 200, detail: 'full' | 'summary' = 'full'): Promise<ConversationReplay> {
    const query = new URLSearchParams({ beforeSequence: String(beforeSequence), limit: String(limit) });
    if (detail !== 'full') query.set('detail', detail);
    if (this.historyEncryption) query.set('historyEncryption', String(HISTORY_ENCRYPTION_CAPABILITY));
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

  /** Cancels the running turn. With `turnId`, only that turn: when it is no
   * longer the active one the backend answers `{ cancelled: false,
   * activeTurnId }`, which callers treat as a no-op. */
  async cancel(id: string, turnId?: string): Promise<ConversationCancelResult> {
    return this.control(id, 'cancel', turnId ? { turnId } : {});
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

  // SSH hosts, keys and remote files (`/v2/ssh/*`, `/v2/ftp/*`, `/v2/remote/*`).
  // Secrets (passwords, passphrases, private keys) only travel in request
  // bodies and are never returned by the backend.

  async listSshHosts(): Promise<SshHostsResponse> {
    return this.request('/v2/ssh/hosts');
  }

  async createSshHost(host: ManagedHost): Promise<{ host: ManagedHost }> {
    return this.request('/v2/ssh/hosts', { method: 'POST', body: JSON.stringify(host) });
  }

  async importSshHosts(text: string): Promise<SshHostImportResult> {
    return this.request('/v2/ssh/hosts/import', { method: 'POST', body: JSON.stringify({ text }) });
  }

  async updateSshHost(alias: string, host: ManagedHost): Promise<{ host: ManagedHost }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}`, { method: 'PUT', body: JSON.stringify(host) });
  }

  async deleteSshHost(alias: string): Promise<{ deleted: boolean }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}`, { method: 'DELETE' });
  }

  /** `GET /v2/agent-desktop`; a 404 (`ConnectionError.httpStatus`) means the daemon predates desktop tools. */
  async getAgentDesktop(): Promise<AgentDesktopSettings> {
    return this.request('/v2/agent-desktop');
  }

  async setAgentDesktopEnabled(enabled: boolean): Promise<AgentDesktopSettings> {
    return this.request('/v2/agent-desktop', { method: 'PUT', body: JSON.stringify({ enabled }) });
  }

  /** Computer Use tools; needs desktop tools on. */
  async setAgentComputerEnabled(computerEnabled: boolean): Promise<AgentDesktopSettings> {
    return this.request('/v2/agent-desktop', { method: 'PUT', body: JSON.stringify({ computerEnabled }) });
  }

  /**
   * Shows the OS prompt for one permission (Screen Recording or Accessibility) on the daemon's
   * host; without `permission`, for each missing one. macOS asks only once, so a permission still
   * missing afterwards also opens its System Settings pane.
   */
  async requestComputerPermissions(permission?: AgentComputerPermission): Promise<AgentDesktopSettings> {
    return this.request('/v2/agent-desktop/computer/permissions', {
      method: 'POST',
      ...(permission ? { body: JSON.stringify({ permission }) } : {}),
    });
  }

  /** The host's screen now; 404 (`ConnectionError.httpStatus`) unless the conversation controls it. */
  async getComputerFrame(conversationId: string): Promise<ComputerFrame> {
    return this.request(`/v2/conversations/${encodeURIComponent(conversationId)}/agent-desktop/frame`);
  }

  /** The conversation's browser tab now (the live stream's polling fallback); 404 without a tab. */
  async getBrowserFrame(conversationId: string): Promise<ComputerFrame> {
    return this.request(`/v2/conversations/${encodeURIComponent(conversationId)}/agent-desktop/frame?capability=browser`);
  }

  /** Starts downloading the daemon's pinned Chromium; progress shows in `browser.chromium`. */
  async installAgentBrowser(): Promise<AgentDesktopSettings> {
    return this.request('/v2/agent-browser/install', { method: 'POST' });
  }

  async getAgentBrowserProfiles(): Promise<AgentBrowserProfiles> {
    return this.request('/v2/agent-browser/profiles');
  }

  async createAgentBrowserProfile(name: string): Promise<AgentBrowserProfile> {
    return this.request('/v2/agent-browser/profiles', { method: 'POST', body: JSON.stringify({ name }) });
  }

  async renameAgentBrowserProfile(id: string, name: string): Promise<AgentBrowserProfiles> {
    return this.request(`/v2/agent-browser/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name }) });
  }

  /** Deletes the profile with its cookies, storage and cache. */
  async deleteAgentBrowserProfile(id: string): Promise<AgentBrowserProfiles> {
    return this.request(`/v2/agent-browser/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** `workspace`: workspace id (path for workspaces without one). Its open tabs close. */
  async assignAgentBrowserProfile(workspace: string, profileId: string): Promise<AgentBrowserProfiles> {
    return this.request('/v2/agent-browser/workspaces', { method: 'PUT', body: JSON.stringify({ workspace, profileId }) });
  }

  /** Stops the agent's desktop browser and/or Computer Use for one conversation; its next tool call asks again. */
  async revokeAgentDesktop(conversationId: string, capability?: 'browser' | 'screen'): Promise<{ conversationId: string; revoked: boolean }> {
    const query = capability ? `?capability=${capability}` : '';
    return this.request(`/v2/conversations/${encodeURIComponent(conversationId)}/agent-desktop${query}`, { method: 'DELETE' });
  }

  async getAgentShot(conversationId: string, shotId: string): Promise<AgentShot> {
    return this.request(`/v2/conversations/${encodeURIComponent(conversationId)}/agent-shots/${encodeURIComponent(shotId)}`);
  }

  async setSshHostAgentAccess(alias: string, enabled: boolean): Promise<{ alias: string; agentAccess: boolean }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/agent-access`, {
      method: 'PUT', body: JSON.stringify({ enabled }),
    });
  }

  async testSshHost(alias: string): Promise<SshTestResult> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/test`, { method: 'POST' });
  }

  /** Closes the shared OpenSSH master connection for the host. */
  async disconnectSshHost(alias: string): Promise<{ disconnected: boolean }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/disconnect`, { method: 'POST' });
  }

  async createFtpSite(site: FtpSiteInput): Promise<{ site: FtpSite }> {
    return this.request('/v2/ftp/sites', { method: 'POST', body: JSON.stringify(site) });
  }

  async updateFtpSite(id: string, site: FtpSiteInput): Promise<{ site: FtpSite }> {
    return this.request(`/v2/ftp/sites/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(site) });
  }

  async deleteFtpSite(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/v2/ftp/sites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async listSshKeys(): Promise<SshKeysResponse> {
    return this.request('/v2/ssh/keys');
  }

  async importSshKey(input: SshKeyImportInput): Promise<{ key: SshKey }> {
    return this.request('/v2/ssh/keys/import', { method: 'POST', body: JSON.stringify(input) });
  }

  async generateSshKey(input: SshKeyGenerateInput): Promise<{ key: SshKey }> {
    // RSA-4096 generation can take several seconds on slow hosts.
    return this.request('/v2/ssh/keys/generate', { method: 'POST', body: JSON.stringify(input) }, Math.max(this.timeout, 60_000));
  }

  async listRemoteConnections(): Promise<{ connections: RemoteConnection[] }> {
    return this.request('/v2/remote/connections');
  }

  async openRemoteConnection(input: OpenRemoteConnectionInput): Promise<{ connection: RemoteConnection }> {
    return this.request('/v2/remote/connections', { method: 'POST', body: JSON.stringify(input) });
  }

  async closeRemoteConnection(id: string): Promise<{ closed: boolean }> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async listRemoteEntries(id: string, path: string): Promise<RemoteEntriesResponse> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/entries?${new URLSearchParams({ path })}`);
  }

  async readRemoteFile(id: string, path: string): Promise<RemoteFile> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/file?${new URLSearchParams({ path })}`);
  }

  /** Compare-and-save; a stale `expectedText` fails with 409 `CONFLICT`. */
  async saveRemoteFile(id: string, path: string, text: string, expectedText: string): Promise<{ saved: boolean }> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/file`, {
      method: 'PUT', body: JSON.stringify({ path, text, expectedText }),
    });
  }

  async createRemoteDirectory(id: string, path: string): Promise<{ ok: boolean }> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/mkdir`, { method: 'POST', body: JSON.stringify({ path }) });
  }

  async renameRemoteEntry(id: string, from: string, to: string): Promise<{ ok: boolean }> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/rename`, { method: 'POST', body: JSON.stringify({ from, to }) });
  }

  /** Deletes a file or an empty directory. */
  async deleteRemoteEntry(id: string, path: string): Promise<{ ok: boolean }> {
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/delete`, { method: 'POST', body: JSON.stringify({ path }) });
  }

  /**
   * Writes one chunk of a file as raw bytes. `offset` 0 creates the file
   * (409 if it exists and `overwrite` is false); later chunks must start at
   * the remote file's current size. Returns the size after the write.
   */
  async uploadRemoteChunk(
    id: string,
    path: string,
    offset: number,
    bytes: Uint8Array,
    overwrite = false,
    timeoutMs = 10 * 60_000,
  ): Promise<{ sizeBytes: number }> {
    const query = new URLSearchParams({ path, offset: String(offset), overwrite: String(overwrite) });
    return this.request(`/v2/remote/connections/${encodeURIComponent(id)}/upload?${query}`, {
      method: 'PUT', body: bytes as Uint8Array<ArrayBuffer>,
    }, timeoutMs);
  }

  /** Raw file bytes (at most `REMOTE_TRANSFER_MAX_BYTES`). */
  async downloadRemoteFile(id: string, path: string, timeoutMs = 10 * 60_000): Promise<Uint8Array> {
    return this.request(
      `/v2/remote/connections/${encodeURIComponent(id)}/download?${new URLSearchParams({ path })}`,
      {},
      timeoutMs,
      'bytes',
    );
  }

  private async request<T>(
    pathAndQuery: string,
    init: { method?: string; body?: string | Uint8Array<ArrayBuffer> } = {},
    timeoutMs = this.timeout,
    responseType: 'json' | 'bytes' = 'json',
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const queryAt = pathAndQuery.indexOf('?');
      const path = queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
      const query = queryAt < 0 ? '' : pathAndQuery.slice(queryAt + 1);
      // Raw byte bodies (remote uploads) are sent as-is; everything else is
      // JSON text. The transport signs the exact bytes.
      const rawBody = init.body instanceof Uint8Array ? init.body : undefined;
      const headers: Record<string, string> = {
        accept: responseType === 'bytes' ? 'application/octet-stream' : 'application/json',
      };
      if (init.body) headers['content-type'] = rawBody ? 'application/octet-stream' : 'application/json';
      if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;

      // The whole body is read (and, through the tunnel, opened) before this
      // resolves, so the timeout also covers a stalled download.
      const response = await this.transport.fetch({
        method: init.method ?? 'GET',
        path,
        query,
        headers,
        body: init.body,
        signal: controller.signal,
      });

      if (response.status < 200 || response.status >= 300) {
        const backendError = parseErrorBody(response.body);
        const backendCode = typeof backendError?.code === 'string' ? backendError.code : undefined;
        const backendMessage = typeof backendError?.message === 'string' ? backendError.message : undefined;
        // `REMOTE_*` codes are SFTP/FTP login failures on the far side, not a
        // rejected device signature; they must reach the caller intact.
        const remoteFailure = backendCode?.startsWith('REMOTE_') === true;
        if ((response.status === 401 && !remoteFailure) || backendCode === 'UNAUTHENTICATED' || backendCode === 'UNAUTHORIZED') {
          throw ConnectionError.authenticationFailed(response.status);
        }
        throw ConnectionError.apiRequestFailed(
          response.status,
          backendCode,
          backendMessage,
        );
      }

      if (responseType === 'bytes') return response.body as T;
      return JSON.parse(new TextDecoder().decode(response.body)) as T;
    } catch (error: unknown) {
      if (error instanceof ConnectionError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw ConnectionError.timeout(`Request timeout after ${timeoutMs}ms`);
      }

      // 网络错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage?.toLowerCase().includes('network') ||
          errorMessage?.toLowerCase().includes('fetch')) {
        throw ConnectionError.networkOffline(errorMessage);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
