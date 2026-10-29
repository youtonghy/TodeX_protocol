import { ConnectionError, isAuthenticationFailure } from './connectionError';
import { deviceAuthQuery, type DeviceIdentity } from './deviceAuth';
import { joinServerPath } from './serverUrl';
import { createSecureTransport, deviceRequestSigner, type SecureTransport } from './secureTransport';
import type { TransportEncryptionProtocol } from './transportCrypto';
import type {
  AgentLocalTerminal,
  AgentOutputFilter,
  FtpSite,
  FtpSiteInput,
  ManagedHost,
  OpenRemoteConnectionInput,
  RemoteConnection,
  RemoteEntriesResponse,
  RemoteFile,
  SshConnectionSettings,
  SshForward,
  SshForwardInput,
  SshHost,
  SshHostImportResult,
  SshHostsResponse,
  SshIpAssignment,
  SshIpAssignmentInput,
  SshIpAssignmentUpdate,
  SshIpPool,
  SshIpPoolConfig,
  SshKey,
  SshKeyGenerateInput,
  SshKeyImportInput,
  SshKeysResponse,
  SshLoginAnswer,
  SshLoginAnswerInput,
  SshTestResult,
} from './ssh';
import type { AgentBrowserProfile, AgentBrowserProfiles, AgentComputerPermission, AgentDesktopSettings, AgentShot, ComputerFrame, HostApps } from './agentDesktop';
import type { AgentCallEventType } from './agentCalling';
import type { PromptUploadChunkResult } from './promptUploads';

/**
 * Client-side guard for `conversation.*` commands sent over /v2/ws. The
 * backend socket accepts up to 8 MiB (legacy chat attachments travel as
 * base64 data URLs without chunking); conversation payloads stay tighter.
 */
export const MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

export type PermissionMode = 'ask' | 'accept-edits' | 'auto' | 'full-access';
export type WorkMode = 'plan' | 'implement';

export type ProviderKind =
  | 'acp'
  | 'codex'
  | 'pi'
  | 'claude-code'
  | 'grok-build'
  | 'devin'
  | 'opencode'
  | 'antigravity'
  | 'deepseek-harness'
  | 'omp';

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  acp: 'ACP',
  codex: 'Codex CLI',
  pi: 'Pi',
  'claude-code': 'Claude Code',
  'grok-build': 'Grok Build',
  devin: 'Devin',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  'deepseek-harness': 'DeepSeek Harness',
  omp: 'omp',
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
  /** `conversation.schedule`: the daemon holds the conversation's queue until
   * a set time (pause reason `scheduled`) and then sends it. */
  scheduledConversations?: boolean;
  /** Session-owned Pi surfaces require explicit support from the connected backend. */
  runtimeStop?: boolean;
  sessionCommands?: boolean;
  extensionUi?: string[];
  extensionMessages?: boolean;
  controlActions?: ConversationControlAction[];
  /** `conversation.compact` accepts `instructions` for the summary. */
  compactInstructions?: boolean;
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
export type ConversationControlAction = 'cancel' | 'interrupt' | 'steer' | 'followUp' | 'retry' | 'resume' | 'fork' | 'forkAt' | 'compact' | 'goal' | 'stop' | 'queue';
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
    scheduledConversations: capabilities.scheduledConversations === true,
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

export type ManagedCliProvider =
  | 'codex'
  | 'pi'
  | 'claude-code'
  | 'grok-build'
  | 'devin'
  | 'opencode'
  | 'antigravity'
  | 'deepseek-harness'
  | 'omp';
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
  /** `image`: installed and updated with the container image; the backend
   * reports `upgradeSupported`/`installSupported` false and answers upgrade
   * or install with 409 `CLI_MANAGED_BY_IMAGE`. Absent otherwise. */
  managedBy?: 'image';
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

/** CLIs whose user settings file (and global instructions) the CLI manager edits. DeepSeek Harness's file is YAML, replaced as text only. */
export type CliSettingsProvider = 'claude-code' | 'codex' | 'pi' | 'deepseek-harness';

/** A CLI's user settings file on the backend host (Claude Code / Pi `settings.json`, Codex `config.toml`, DeepSeek Harness's acp profile patch). */
export type CliSettingsDocument = {
  path: string;
  /** `yaml`: a DeepSeek Harness patch layer; `settings` is always `{}` and only `replaceCliSettings` writes it. */
  format: 'json' | 'toml' | 'yaml';
  exists: boolean;
  /** Content hash every write must echo back; `"missing"` before the file exists. */
  revision: string;
  /** The file as stored; empty when it does not exist. */
  text: string;
  /** The parsed object (TOML as its JSON equivalent); `null` when `text` does not parse (see `parseError`). */
  settings: Record<string, unknown> | null;
  parseError?: string;
};

/** A package in Pi's global `settings.json` `packages`. `filtered` entries carry `pi config` resource filters and are not toggled from TodeX. */
export type PiPackage = {
  source: string;
  state: 'enabled' | 'disabled' | 'filtered';
  installedPath?: string;
  name?: string;
  version?: string;
  description?: string;
};

export type PiBuiltinExtensionId = 'mcp' | 'codemode' | 'tool-search' | 'llama.cpp';

export type PiPluginList = {
  settingsPath: string;
  /** Revision of `settings.json`, echoed by `setPiPluginState`. */
  revision: string;
  packages: PiPackage[];
  builtins: { id: PiBuiltinExtensionId; enabled: boolean }[];
  /** Why `pi list` could not report install paths. */
  listError?: string;
  parseError?: string;
};

/** Known Pi extensions whose configuration file the backend reads and writes. */
export type PiPluginConfigId =
  | 'permission-system' | 'mcp-adapter' | 'web-access' | 'exa' | 'fff' | 'subagents'
  | 'goal' | 'plan-mode' | 'tasks' | 'context-prune' | 'cache-optimizer';

/** Stands in for a stored credential; sending it back keeps the stored value. */
export const PI_SECRET_PLACEHOLDER = '__todex_secret__';

/** A known Pi extension's configuration file, without its raw text; credentials are masked with `PI_SECRET_PLACEHOLDER`. */
export type PiPluginConfigDocument = {
  plugin: PiPluginConfigId;
  path: string;
  exists: boolean;
  revision: string;
  settings: Record<string, unknown> | null;
  parseError?: string;
};

/** A global `@tintinweb/pi-subagents` agent type: `<pi_dir>/agents/<file>.md`. */
export type PiSubagentTemplateSummary = {
  file: string;
  /** The agent type: front matter `name`, else `file`. */
  name: string;
  displayName?: string;
  description?: string;
  color?: string;
  model?: string;
  enabled: boolean;
  overridesBuiltIn: boolean;
  parseError?: string;
};

export type PiBuiltInSubagent = {
  name: string;
  /** `disabled`: an `enabled: false` stub named after it; `overridden`: a template of the same type replaces it. */
  state: 'enabled' | 'disabled' | 'overridden';
  file?: string;
};

export type PiSubagentTemplateList = {
  dir: string;
  templates: PiSubagentTemplateSummary[];
  builtIns: PiBuiltInSubagent[];
};

export type PiSubagentTemplateDocument = {
  file: string;
  path: string;
  revision: string;
  content: string;
  /** `null` when the file does not parse. */
  frontMatter: Record<string, unknown> | null;
  body: string;
  parseError?: string;
};

/** The raw file, or a front matter patch (`null` removes a key) plus the new body. */
export type PiSubagentTemplateInput = { content: string } | { frontMatter: Record<string, unknown>; body: string };

export type PiPackageOperation = {
  id: string;
  action: 'install' | 'remove';
  source: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

/** An npm/git plugin from `omp plugin list --json`. */
export type OmpPlugin = {
  name: string;
  version: string;
  enabled: boolean;
  description?: string;
  /** Optional features the plugin's manifest offers. */
  features: string[];
  /** Enabled features; absent means the manifest defaults. */
  enabledFeatures?: string[];
};

/** A marketplace install, listed read-only (managed in omp). */
export type OmpMarketplacePlugin = { id: string; version?: string; scope: string };

export type OmpPluginList = {
  plugins: OmpPlugin[];
  marketplace: OmpMarketplacePlugin[];
  /** Why omp could not list its plugins. */
  error?: string;
};

export type OmpPluginOperation = {
  id: string;
  action: 'install' | 'uninstall' | 'upgrade';
  /** An npm spec or git URL to install, or an installed plugin's name. */
  spec: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

/** How Pi offers an MCP server's tools to the model. */
export type PiMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

/** One `mcpServers` entry of Pi's `mcp.json`: stdio (`command`) or streamable HTTP (`url`). Unknown keys are kept. */
export type PiMcpServerConfig = {
  type?: 'stdio' | 'http' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  exposure?: PiMcpExposure | 'codemode-deferred';
  toolExposure?: Record<string, PiMcpExposure>;
  enabled?: boolean;
  timeout?: number;
  description?: string;
  [key: string]: unknown;
};

/** Pi's global `<pi_dir>/mcp.json`; `env` and `headers` values are served as stored. */
export type PiMcpDocument = {
  path: string;
  exists: boolean;
  revision: string;
  /** The parsed file; `null` when it does not parse (see `parseError`). */
  config: { mcpServers?: Record<string, PiMcpServerConfig>; autoEnableCodemode?: boolean; [key: string]: unknown } | null;
  parseError?: string;
  /** `builtin:mcp` is on in `settings.json`; Pi ignores `mcp.json` while it is off. */
  builtinEnabled: boolean;
  /** An enabled `pi-mcp-adapter` package takes over `/mcp`, so Pi ignores `mcp.json`. */
  adapterInstalled: boolean;
};

/** How a composed DeepSeek Harness plugin row is switched. `conditional` rows follow a `!!js` expression. */
export type DshRowState =
  | { kind: 'enabled' }
  | { kind: 'disabled' }
  | { kind: 'conditional'; expression: string };

/** One row of DeepSeek Harness's composed `acp` profile (`dsh --dump-config`). */
export type DshPluginRow = {
  id?: string;
  /** The plugin module, e.g. `@deepseek-ai/dsh-web`. */
  name: string;
  state: DshRowState;
  /** The bundle package or patch file that declared the row. */
  source: string;
  sourceLayer: 'bundle' | 'profile' | 'home' | 'todex' | 'other';
  patchedBy?: string[];
  /** TodeX's launch overlay keeps it off (it uploads data to the DeepSeek API). */
  locked: boolean;
  /** `$DSH_HOME/cordis.patch.yml` decides its state. */
  overridden: boolean;
  toggleable: boolean;
  /** `getDshPluginConfig` has a settings page for it. */
  configurable: boolean;
};

/** A bundle the acp profile composes or a package it installs. */
export type DshPackage = {
  name: string;
  /** The dependency spec; absent for bundles the dsh installation supplies. */
  spec?: string;
  version?: string;
  description?: string;
  /** Declares a dsh bundle patch. */
  bundle: boolean;
  /** Listed in `dsh.profile.bundles`. */
  selected: boolean;
  /** Supplied by the dsh installation: neither removable nor deselectable. */
  builtin: boolean;
};

export type DshPluginList = {
  profilePath: string;
  /** Revision of the profile patch, echoed by `setDshPluginState` and settings pages. */
  revision: string;
  /** Revision of the profile manifest, echoed by `setDshBundleSelected`. */
  manifestRevision: string;
  runtimeVersion?: string;
  /** Installing and removing packages needs pnpm on the backend host. */
  pnpmAvailable: boolean;
  rows: DshPluginRow[];
  packages: DshPackage[];
  exemptions: { package: string; runtimeVersions: string[] }[];
  /** Why `dsh --dump-config` failed; `rows` is empty then. */
  composeError?: string;
  /** The profile patch cannot be edited entry by entry (edit its YAML instead). */
  parseError?: string;
};

export type DshPluginConfigId = 'web' | 'web-deepseek-api';

/** A known dsh plugin's effective settings, as composed. */
export type DshPluginConfigDocument = {
  id: DshPluginConfigId;
  revision: string;
  config: Record<string, unknown>;
  /** The home-level patch sets this row's config: read only. */
  overridden: boolean;
};

export type DshPluginOperation = {
  id: string;
  action: 'install' | 'remove' | 'allow-version' | 'revoke-version';
  source: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Packages refused for their version, with the exemption that would admit each. */
  incompatible?: { package: string; runtimeVersion: string }[];
};

/** A CLI's global instruction file on the backend host (Claude Code `CLAUDE.md`, Codex / Pi / DeepSeek Harness `AGENTS.md`). */
export type CliInstructionsDocument = {
  path: string;
  exists: boolean;
  /** Content hash every write must echo back; `"missing"` before the file exists. */
  revision: string;
  /** The file as stored; empty when it does not exist. */
  text: string;
  /** The instruction preset the file follows; absent when it keeps its own text. */
  presetId?: string;
  /** The file was edited after its preset was last written to it; preset edits leave it alone. */
  drifted: boolean;
  /** An existing file the CLI reads instead of this one (Codex `AGENTS.override.md`). */
  overridePath?: string;
};

/** A shared instruction text that CLIs can follow; edits rewrite the files that follow it. */
export type InstructionPreset = {
  id: string;
  name: string;
  text: string;
  /** Bumped on every edit; updates must echo it back. */
  revision: number;
  updatedAt: number;
  /** CLIs whose instruction file follows this preset. */
  usedBy: CliSettingsProvider[];
};

/** What a preset edit did to each file that follows it: `drifted` files were edited meanwhile and left alone. */
export type InstructionPresetSync = {
  provider: CliSettingsProvider;
  status: 'updated' | 'drifted' | 'failed';
  message?: string;
};

export type InstructionPresetUpdate = {
  preset: InstructionPreset;
  sync: InstructionPresetSync[];
};

export type CliVersionsResponse = {
  clis: CliVersionInfo[];
  /** When the oldest latest-release check in `clis` ran. */
  checkedAt: string;
  /** The earliest-started running operation; kept for clients that track only one. */
  activeOperation?: CliUpgradeOperation;
  /** Every running install or upgrade, at most one per CLI. Missing on older backends, which run one at a time. */
  activeOperations?: CliUpgradeOperation[];
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

export type ManagedProviderAgent = 'codex' | 'claude-code' | 'grok-build' | 'pi' | 'opencode' | 'deepseek-harness' | 'omp';

export const MANAGED_PROVIDER_AGENTS: ManagedProviderAgent[] = ['codex', 'claude-code', 'grok-build', 'pi', 'opencode', 'deepseek-harness', 'omp'];

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
  /** Shipped and managed by the CLI itself (Codex's `skills/.system`); absent when false or on old daemons. */
  builtIn?: boolean;
};

export type SkillCatalog = {
  provider: ProviderKind;
  skills: SkillCatalogDescriptor[];
  /** Whether listed skills can be edited and deleted; absent on old daemons. */
  editable?: boolean;
  /** Sources a new skill can be created in (`shared-user`, `provider-project`, …). */
  creatableSources?: string[];
};

/** One file of a skill directory, relative to the skill root ('/'-separated). */
export type SkillBundleFile = {
  path: string;
  contentBase64: string;
  executable?: boolean;
};

/** A whole skill directory (`SKILL.md` plus assets). Symlinks and special
 * files are not followed and are listed in `skipped`. */
export type SkillBundle = {
  resourceId: string;
  name: string;
  source: string;
  files: SkillBundleFile[];
  skipped: string[];
};

/** Bundle ceilings the backend enforces on read and write. */
export const SKILL_BUNDLE_MAX_FILES = 200;
export const SKILL_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;

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

/** One MCP entry exactly as declared in its config file (TOML converted to
 * JSON), credentials included. */
export type McpServerConfig = {
  descriptor: McpServerCatalogDescriptor;
  path: string;
  /** `dsh_patch`: a DeepSeek Harness `dsh-mcp-client` row, shown and edited as entry JSON. */
  format: 'json' | 'toml' | 'native' | 'dsh_patch';
  config: unknown;
};

export type McpCatalog = {
  provider: ProviderKind;
  servers: McpServerCatalogDescriptor[];
  /** Whether listed entries can be edited and deleted; absent on old daemons. */
  editable?: boolean;
  /** Scopes a new entry can be added to. */
  creatableScopes?: CatalogScope[];
};

export type ConversationManifest = {
  schemaVersion: number;
  id: string;
  provider: ProviderKind;
  ownerId: string;
  workspace: string;
  workspaceId?: string;
  /** `workspace` is a folder the daemon created for this conversation under
   * `scratch_workspace_root` because it was started without a workspace
   * (the clients' "None" workspace). Omitted when false. */
  scratchWorkspace?: boolean;
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
  /** Set on a child conversation an agent started through the `todex_agents`
   * MCP server (Agent Calling): the calling conversation. Children are left
   * out of `GET /v2/conversations` unless `includeChildren=true`. */
  parentConversationId?: string;
  /** Scheduled conversation: its follow-up queue is held (pause reason
   * `scheduled`) until `at`, then sent. The held prompts live in daemon
   * memory only, so a daemon restart loses them and marks the schedule
   * `interrupted` until the client re-arms or cancels it. */
  schedule?: ConversationSchedule;
};

// ---- Agent Calling (`/v2/agent-calling`, `/v2/api-keys`) -------------------

/** Which agents and models agents may call (MCP entry) and API keys may use
 * (CLI entry, intersected with each key's own scopes). */
export type AgentScope = {
  /** `null`: every agent; otherwise only these provider ids (may be empty). */
  agents: ProviderKind[] | null;
  /** Provider id → allowed model ids (never empty). A provider absent from
   * the map may use all of its models. */
  models: Partial<Record<ProviderKind, string[]>>;
};

/** How permission requests of an agent call or API-key conversation are answered. */
export type AgentCallingApproval = 'ask' | 'auto-approve' | 'reject';

/** `GET|PUT /v2/agent-calling`. A 404 means the daemon predates Agent Calling. */
export type AgentCallingSettings = {
  scope: AgentScope;
  mcp: {
    enabled: boolean;
    approval: AgentCallingApproval;
    /** The `todex_agents` MCP server would be injected now (enabled and at least one agent allowed). */
    injected: boolean;
  };
  /** The external API listener (`/api/v1`, config.toml `[api]`). */
  apiListener: {
    /** Saved config. */
    enabled: boolean;
    host: string;
    /** Saved config. */
    port: number;
    /** A listener runs in this backend process. */
    listening: boolean;
    /** The running listener's base URL (`http://127.0.0.1:7346/api/v1`); null when not listening. */
    baseUrl: string | null;
    /** The saved config differs from the running listener; takes effect after a backend restart. */
    pendingRestart: boolean;
  };
  limits: { maxConcurrentCalls: number; maxWaitSecs: number; defaultWaitSecs: number };
};

/** `PUT /v2/agent-calling`; absent fields stay as they are. */
export type AgentCallingUpdate = {
  scope?: AgentScope;
  mcp?: { enabled?: boolean; approval?: AgentCallingApproval };
};

/** `PUT /v2/agent-calling/api-listener`; takes effect after a backend restart. */
export type ApiListenerUpdate = { enabled?: boolean; port?: number };

/** What an API key may reach; an absent field means every agent / every workspace. */
export type ApiKeyScopes = {
  /** Provider ids; never empty when present. */
  agents?: ProviderKind[];
  /** Absolute workspace roots (1..64); never empty when present. */
  workspaces?: string[];
};

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/** One key in `GET /v2/api-keys` (no secret). Times are Unix milliseconds. */
export type ApiKeySummary = {
  id: string;
  name: string;
  /** `tdx_<id>`: the start of the key, safe to show. */
  prefix: string;
  status: ApiKeyStatus;
  scopes: ApiKeyScopes;
  approval: AgentCallingApproval;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

/** `POST /v2/api-keys`. `name` is 1..100 characters; `expiresAt` (Unix ms) must lie in the future. */
export type ApiKeyCreateRequest = {
  name: string;
  scopes?: ApiKeyScopes;
  approval?: AgentCallingApproval;
  expiresAt?: number | null;
};

/** `POST /v2/api-keys` result: the summary plus the full key, returned only this once. */
export type ApiKeyCreated = ApiKeySummary & { key: string };

/** `PATCH /v2/api-keys/{id}`; absent fields stay as they are. `scopes`
 * replaces the whole scope object; `expiresAt: null` clears the expiry. */
export type ApiKeyUpdate = {
  name?: string;
  scopes?: ApiKeyScopes;
  approval?: AgentCallingApproval;
  expiresAt?: number | null;
};

export type ConversationSchedule = { at: string; interrupted?: boolean };

/** `manifest.schedule`, or undefined when absent or malformed. */
export function parseConversationSchedule(value: unknown): ConversationSchedule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = typeof record.at === 'string' ? record.at.trim() : '';
  if (!at || !Number.isFinite(Date.parse(at))) return undefined;
  return record.interrupted === true ? { at, interrupted: true } : { at };
}

/** One conversation in GET /v2/history/storage: its manifest plus the bytes
 * its directory takes on the daemon's disk. */
export type ConversationStorageEntry = ConversationManifest & { bytes: number };

export type HistoryStorageResponse = {
  totalBytes: number;
  count: number;
  measuredAt: string;
  conversations: ConversationStorageEntry[];
};

export type HistoryCleanupSkip = { conversationId: string; code: string; message: string };

export type HistoryCleanupResult = {
  deleted: string[];
  skipped: HistoryCleanupSkip[];
  freedBytes: number;
};

/** Automatic cleanup of the tenant's conversations. Enabled requires at least
 * one threshold; the age rule runs first, then the oldest conversations go
 * until the total fits under `maxTotalBytes`. Active ones are never removed. */
export type HistoryCleanupPolicy = {
  enabled: boolean;
  maxAgeDays: number | null;
  maxTotalBytes: number | null;
};

export type HistoryCleanupRun = {
  at: string;
  trigger: 'auto' | 'manual';
  deleted: number;
  freedBytes: number;
  error: string | null;
};

export type HistoryCleanupPolicyResponse = {
  policy: HistoryCleanupPolicy;
  lastRun: HistoryCleanupRun | null;
  nextRunAt: string | null;
};

/** Agents whose own session history the daemon can manage. */
export type NativeHistoryProvider = 'claude-code' | 'pi' | 'codex' | 'grok-build' | 'devin' | 'omp';

export type NativeHistoryProviderInfo = {
  provider: NativeHistoryProvider;
  available: boolean;
  root: string | null;
  sessionCount: number;
  totalBytes: number;
  measuredAt: string;
  /** `view`: transcripts can be read. `sizes`: per-session sizes are known;
   * without them sessions report null bytes and size limits are refused. */
  capabilities: { view: boolean; sizes: boolean };
  /** Claude Code's own retention setting; null for agents without one. */
  native: { cleanupPeriodDays: number | null; settingsPath: string } | null;
};

export type NativeHistorySession = {
  id: string;
  title: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string;
  bytes: number | null;
  /** TodeX conversations resuming this session; they protect it. */
  referencedBy: string[];
  running: boolean;
};

export type NativeHistorySessionsResponse = {
  provider: NativeHistoryProvider;
  root: string | null;
  totalBytes: number;
  count: number;
  measuredAt: string;
  sessions: NativeHistorySession[];
};

export type NativeHistoryMessage = { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; at: string | null };

export type NativeHistoryTranscript = {
  provider: NativeHistoryProvider;
  id: string;
  title: string | null;
  cwd: string | null;
  totalMessages: number;
  /** Earlier messages were left out; `messages` holds the last ones. */
  truncated: boolean;
  messages: NativeHistoryMessage[];
};

export type ClaudeNativeRetention = { cleanupPeriodDays: number | null; settingsPath: string };

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
  | AgentCallEventType
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
  if (/^(?:message|turn|permission|usage|subagent|compaction|goal|memory|extension|agent\.call)\./.test(event.type) || event.type === 'provider.runtime') return event.type;
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

/** Exactly one of `workspace` and `scratchWorkspace: true`. */
export type CreateConversationInput = {
  provider: ProviderKind;
  workspace?: string;
  /** Start without a workspace: the daemon creates the conversation's own
   * folder under `scratch_workspace_root`. */
  scratchWorkspace?: boolean;
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
  return joinServerPath(
    normalized.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://'),
    '/v2/ws',
  );
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

  /** `refresh` re-queries every CLI's latest release instead of using the backend's cache. */
  async listCliVersions(options: { refresh?: boolean } = {}): Promise<CliVersionsResponse> {
    return this.request(options.refresh ? '/v2/providers/versions?refresh=true' : '/v2/providers/versions');
  }

  async upgradeCli(provider: ManagedCliProvider): Promise<CliUpgradeOperation> {
    return this.request(`/v2/providers/${encodeURIComponent(provider)}/upgrade`, { method: 'POST' });
  }

  async installCli(provider: ManagedCliProvider): Promise<CliUpgradeOperation> {
    return this.request(`/v2/providers/${encodeURIComponent(provider)}/install`, { method: 'POST' });
  }

  /** Removes TodeX's approval hook and MCP entries from the Antigravity global config; the next Antigravity turn installs them again. */
  async removeAntigravityIntegration(): Promise<{ removed: boolean }> {
    return this.request('/v2/providers/antigravity/integration', { method: 'DELETE' });
  }

  async getCliSettings(provider: CliSettingsProvider): Promise<CliSettingsDocument> {
    return this.request(`/v2/providers/${provider}/settings`);
  }

  /** RFC 7386 merge patch: `null` removes a key, objects merge, other values replace. A stale `revision` is `409 CONFLICT`. */
  async patchCliSettings(provider: CliSettingsProvider, revision: string, patch: Record<string, unknown>): Promise<CliSettingsDocument> {
    return this.request(`/v2/providers/${provider}/settings`, { method: 'PATCH', body: JSON.stringify({ revision, patch }) });
  }

  /** Replaces the whole file with `text`, which must parse (a JSON object, TOML, or a YAML list of dsh patch entries). A stale `revision` is `409 CONFLICT`. */
  async replaceCliSettings(provider: CliSettingsProvider, revision: string, text: string): Promise<CliSettingsDocument> {
    return this.request(`/v2/providers/${provider}/settings`, { method: 'PUT', body: JSON.stringify({ revision, text }) });
  }

  async listPiPlugins(): Promise<PiPluginList> {
    return this.request('/v2/providers/pi/plugins');
  }

  /** Enables or disables a configured package or built-in extension. A stale `revision` is `409 CONFLICT`. */
  async setPiPluginState(revision: string, target: { source: string } | { builtin: PiBuiltinExtensionId }, enabled: boolean): Promise<PiPluginList> {
    return this.request('/v2/providers/pi/plugins/state', { method: 'PUT', body: JSON.stringify({ revision, ...target, enabled }) });
  }

  /** Starts `pi install` / `pi remove` in the background; poll `getPiPackageOperation`. */
  async startPiPackageOperation(action: PiPackageOperation['action'], source: string): Promise<PiPackageOperation> {
    return this.request('/v2/providers/pi/plugins/operations', { method: 'POST', body: JSON.stringify({ action, source }) });
  }

  async getPiPackageOperation(operationId: string): Promise<PiPackageOperation> {
    return this.request(`/v2/providers/pi/plugins/operations/${encodeURIComponent(operationId)}`);
  }

  async listOmpPlugins(): Promise<OmpPluginList> {
    return this.request('/v2/providers/omp/plugins');
  }

  /** Runs `omp plugin enable|disable <name>` and returns the new list. */
  async setOmpPluginEnabled(name: string, enabled: boolean): Promise<OmpPluginList> {
    return this.request('/v2/providers/omp/plugins/state', { method: 'PUT', body: JSON.stringify({ name, enabled }) });
  }

  /** Starts `omp plugin install|uninstall|upgrade` in the background; poll `getOmpPluginOperation`. */
  async startOmpPluginOperation(action: OmpPluginOperation['action'], spec: string): Promise<OmpPluginOperation> {
    return this.request('/v2/providers/omp/plugins/operations', { method: 'POST', body: JSON.stringify({ action, spec }) });
  }

  async getOmpPluginOperation(operationId: string): Promise<OmpPluginOperation> {
    return this.request(`/v2/providers/omp/plugins/operations/${encodeURIComponent(operationId)}`);
  }

  async getPiPluginConfig(plugin: PiPluginConfigId): Promise<PiPluginConfigDocument> {
    return this.request(`/v2/providers/pi/plugin-config/${plugin}`);
  }

  /**
   * RFC 7386 merge patch; `PI_SECRET_PLACEHOLDER` values are ignored. Each key path in `replace` is then set
   * to the patch's object as sent, keeping its key order. A stale `revision` is `409 CONFLICT`.
   */
  async patchPiPluginConfig(plugin: PiPluginConfigId, revision: string, patch: Record<string, unknown>, replace: string[][] = []): Promise<PiPluginConfigDocument> {
    return this.request(`/v2/providers/pi/plugin-config/${plugin}`, { method: 'PATCH', body: JSON.stringify({ revision, patch, replace }) });
  }

  async listPiSubagentTemplates(): Promise<PiSubagentTemplateList> {
    return this.request('/v2/providers/pi/subagent-templates');
  }

  async getPiSubagentTemplate(file: string): Promise<PiSubagentTemplateDocument> {
    return this.request(`/v2/providers/pi/subagent-templates/${encodeURIComponent(file)}`);
  }

  /** Creates `<file>.md`; an existing file is `409 CONFLICT`. */
  async createPiSubagentTemplate(file: string, input: PiSubagentTemplateInput): Promise<PiSubagentTemplateDocument> {
    return this.request('/v2/providers/pi/subagent-templates', { method: 'POST', body: JSON.stringify({ file, ...input }) });
  }

  /** A stale `revision` is `409 CONFLICT`; a form update of an unparseable file is `409` too. */
  async updatePiSubagentTemplate(file: string, revision: string, input: PiSubagentTemplateInput): Promise<PiSubagentTemplateDocument> {
    return this.request(`/v2/providers/pi/subagent-templates/${encodeURIComponent(file)}`, { method: 'PUT', body: JSON.stringify({ revision, ...input }) });
  }

  async deletePiSubagentTemplate(file: string): Promise<void> {
    await this.request(`/v2/providers/pi/subagent-templates/${encodeURIComponent(file)}`, { method: 'DELETE' });
  }

  /** Switches a built-in agent through its `enabled: false` stub; an overridden one is `409 CONFLICT`. */
  async setPiBuiltInSubagent(name: string, enabled: boolean): Promise<PiSubagentTemplateList> {
    return this.request(`/v2/providers/pi/subagent-templates/built-ins/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  }

  async listDshPlugins(): Promise<DshPluginList> {
    return this.request('/v2/providers/deepseek-harness/plugins');
  }

  /** Turns a composed row on or off in the acp profile patch. A stale `revision` is `409 CONFLICT`. */
  async setDshPluginState(revision: string, id: string, enabled: boolean): Promise<DshPluginList> {
    return this.request('/v2/providers/deepseek-harness/plugins/state', { method: 'PUT', body: JSON.stringify({ revision, id, enabled }) });
  }

  /** Selects or deselects an installed bundle; `manifestRevision` comes from the list. */
  async setDshBundleSelected(manifestRevision: string, name: string, enabled: boolean): Promise<DshPluginList> {
    return this.request('/v2/providers/deepseek-harness/plugins/bundles', { method: 'PUT', body: JSON.stringify({ revision: manifestRevision, name, enabled }) });
  }

  /**
   * Starts `dsh plugin --profile acp add|remove|allow-version|revoke-version` in the background; poll
   * `getDshPluginOperation`. Exemptions name `package@version` as `source` plus `runtimeVersion`;
   * `allow-version` needs `acceptRisk` after the user accepted that an incompatible plugin may break dsh.
   */
  async startDshPluginOperation(
    action: DshPluginOperation['action'],
    source: string,
    options: { runtimeVersion?: string; acceptRisk?: boolean } = {},
  ): Promise<DshPluginOperation> {
    return this.request('/v2/providers/deepseek-harness/plugins/operations', { method: 'POST', body: JSON.stringify({ action, source, ...options }) });
  }

  async getDshPluginOperation(operationId: string): Promise<DshPluginOperation> {
    return this.request(`/v2/providers/deepseek-harness/plugins/operations/${encodeURIComponent(operationId)}`);
  }

  async getDshPluginConfig(id: DshPluginConfigId): Promise<DshPluginConfigDocument> {
    return this.request(`/v2/providers/deepseek-harness/plugin-config/${id}`);
  }

  /** Sets top-level fields (`null` keeps the composed value); the backend pins the whole row config. */
  async patchDshPluginConfig(id: DshPluginConfigId, revision: string, patch: Record<string, unknown>): Promise<DshPluginConfigDocument> {
    return this.request(`/v2/providers/deepseek-harness/plugin-config/${id}`, { method: 'PATCH', body: JSON.stringify({ revision, patch }) });
  }

  async getPiMcp(): Promise<PiMcpDocument> {
    return this.request('/v2/providers/pi/mcp');
  }

  /**
   * Each `mcpServers` entry replaces the stored server of that name, or removes it when `null`; `autoEnableCodemode`
   * is set, or removed when `null`. Entries are checked with Pi's rules (`400`); a stale `revision` is `409 CONFLICT`.
   */
  async patchPiMcp(
    revision: string,
    patch: { mcpServers?: Record<string, PiMcpServerConfig | null>; autoEnableCodemode?: boolean | null },
  ): Promise<PiMcpDocument> {
    return this.request('/v2/providers/pi/mcp', { method: 'PATCH', body: JSON.stringify({ revision, patch }) });
  }

  async getCliInstructions(provider: CliSettingsProvider): Promise<CliInstructionsDocument> {
    return this.request(`/v2/providers/${provider}/instructions`);
  }

  /** Writes the file's own text and stops it following a preset. A stale `revision` is `409 CONFLICT`. */
  async writeCliInstructions(provider: CliSettingsProvider, revision: string, text: string): Promise<CliInstructionsDocument> {
    return this.request(`/v2/providers/${provider}/instructions`, { method: 'PUT', body: JSON.stringify({ revision, text }) });
  }

  /** Makes the file follow `presetId` (writing the preset's text, also when it already follows it), or keep its current text when `null`. */
  async setCliInstructionsSource(provider: CliSettingsProvider, revision: string, presetId: string | null): Promise<CliInstructionsDocument> {
    return this.request(`/v2/providers/${provider}/instructions/source`, { method: 'PUT', body: JSON.stringify({ revision, presetId }) });
  }

  async listInstructionPresets(): Promise<{ presets: InstructionPreset[] }> {
    return this.request('/v2/instruction-presets');
  }

  async createInstructionPreset(name: string, text: string): Promise<InstructionPreset> {
    return this.request('/v2/instruction-presets', { method: 'POST', body: JSON.stringify({ name, text }) });
  }

  /** A stale `revision` is `409 CONFLICT`. */
  async updateInstructionPreset(id: string, revision: number, name: string, text: string): Promise<InstructionPresetUpdate> {
    return this.request(`/v2/instruction-presets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ revision, name, text }) });
  }

  /** CLIs that followed the preset keep their text as their own. */
  async deleteInstructionPreset(id: string): Promise<void> {
    await this.request(`/v2/instruction-presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  async getMcpServerConfig(provider: ProviderKind, workspace: string, resourceId: string): Promise<McpServerConfig> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/mcp/${encodeURIComponent(resourceId)}?${query}`);
  }

  async deleteMcpServer(provider: ProviderKind, workspace: string, resourceId: string): Promise<{ resourceId: string; name: string; path: string }> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/mcp/${encodeURIComponent(resourceId)}?${query}`, { method: 'DELETE' });
  }

  async updateMcpServer(provider: ProviderKind, workspace: string, resourceId: string, input: { name: string; config: unknown }): Promise<McpServerConfig> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/mcp/${encodeURIComponent(resourceId)}?${query}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async createMcpServer(provider: ProviderKind, workspace: string, input: { scope: CatalogScope; name: string; config: unknown }): Promise<McpServerConfig> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/mcp?${query}`, { method: 'POST', body: JSON.stringify(input) });
  }

  async createSkill(provider: ProviderKind, workspace: string, input: { source: string; name: string; content: string }): Promise<SkillCatalogDescriptor> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills?${query}`, { method: 'POST', body: JSON.stringify(input) });
  }

  async updateSkill(provider: ProviderKind, workspace: string, resourceId: string, content: string): Promise<SkillCatalogDescriptor> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/${encodeURIComponent(resourceId)}?${query}`, { method: 'PUT', body: JSON.stringify({ content }) });
  }

  /** The whole skill directory; a 404 on an existing skill means the daemon predates bundles. */
  async getSkillBundle(provider: ProviderKind, workspace: string, resourceId: string): Promise<SkillBundle> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/${encodeURIComponent(resourceId)}/bundle?${query}`);
  }

  /** Replaces the skill directory with exactly `files`, which must include `SKILL.md`. */
  async replaceSkillBundle(provider: ProviderKind, workspace: string, resourceId: string, files: SkillBundleFile[]): Promise<SkillCatalogDescriptor> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/${encodeURIComponent(resourceId)}/bundle?${query}`, { method: 'PUT', body: JSON.stringify({ files }) });
  }

  /** Creates a skill directory from `files`; `409` when it already exists. */
  async createSkillBundle(provider: ProviderKind, workspace: string, input: { source: string; name: string; files: SkillBundleFile[] }): Promise<SkillCatalogDescriptor> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/bundle?${query}`, { method: 'POST', body: JSON.stringify(input) });
  }

  async deleteSkill(provider: ProviderKind, workspace: string, resourceId: string): Promise<{ resourceId: string; name: string; path: string }> {
    const query = new URLSearchParams({ provider, workspace });
    return this.request(`/v2/catalog/skills/${encodeURIComponent(resourceId)}?${query}`, { method: 'DELETE' });
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

  async getHistoryStorage(): Promise<HistoryStorageResponse> {
    return this.request('/v2/history/storage');
  }

  async cleanupConversations(conversationIds: string[]): Promise<HistoryCleanupResult> {
    return this.request('/v2/history/cleanup', { method: 'POST', body: JSON.stringify({ conversationIds }) });
  }

  async getHistoryCleanupPolicy(): Promise<HistoryCleanupPolicyResponse> {
    return this.request('/v2/history/cleanup-policy');
  }

  async updateHistoryCleanupPolicy(policy: HistoryCleanupPolicy): Promise<HistoryCleanupPolicyResponse> {
    return this.request('/v2/history/cleanup-policy', { method: 'PUT', body: JSON.stringify(policy) });
  }

  async runHistoryCleanupPolicy(): Promise<HistoryCleanupResult & { lastRun: HistoryCleanupRun }> {
    return this.request('/v2/history/cleanup-policy/run', { method: 'POST' });
  }

  async listNativeHistoryProviders(): Promise<{ providers: NativeHistoryProviderInfo[] }> {
    return this.request('/v2/native-history/providers');
  }

  async listNativeHistorySessions(provider: NativeHistoryProvider): Promise<NativeHistorySessionsResponse> {
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/sessions`);
  }

  async getNativeHistoryTranscript(provider: NativeHistoryProvider, id: string, limit = 200): Promise<NativeHistoryTranscript> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/sessions/${encodeURIComponent(id)}/transcript?${query}`);
  }

  async cleanupNativeHistory(provider: NativeHistoryProvider, sessionIds: string[]): Promise<HistoryCleanupResult> {
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/cleanup`, { method: 'POST', body: JSON.stringify({ sessionIds }) });
  }

  async getNativeHistoryPolicy(provider: NativeHistoryProvider): Promise<HistoryCleanupPolicyResponse> {
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/policy`);
  }

  async updateNativeHistoryPolicy(provider: NativeHistoryProvider, policy: HistoryCleanupPolicy): Promise<HistoryCleanupPolicyResponse> {
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/policy`, { method: 'PUT', body: JSON.stringify(policy) });
  }

  async runNativeHistoryPolicy(provider: NativeHistoryProvider): Promise<HistoryCleanupResult & { lastRun: HistoryCleanupRun }> {
    return this.request(`/v2/native-history/${encodeURIComponent(provider)}/policy/run`, { method: 'POST' });
  }

  async getClaudeNativeRetention(): Promise<ClaudeNativeRetention> {
    return this.request('/v2/native-history/claude-code/native-retention');
  }

  async updateClaudeNativeRetention(cleanupPeriodDays: number | null): Promise<ClaudeNativeRetention> {
    return this.request('/v2/native-history/claude-code/native-retention', { method: 'PUT', body: JSON.stringify({ cleanupPeriodDays }) });
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

  /**
   * Apps on the daemon's host for `@app:` mentions; 409 while Computer Use is off, 404 from
   * daemons that predate the list (`ConnectionError.httpStatus`).
   */
  async listComputerApps(): Promise<HostApps> {
    return this.request('/v2/agent-desktop/computer/apps');
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

  /** `GET /v2/agent-calling`; a 404 (`ConnectionError.httpStatus`) means the daemon predates Agent Calling. */
  async getAgentCalling(): Promise<AgentCallingSettings> {
    return this.request('/v2/agent-calling');
  }

  async setAgentCalling(update: AgentCallingUpdate): Promise<AgentCallingSettings> {
    return this.request('/v2/agent-calling', { method: 'PUT', body: JSON.stringify(update) });
  }

  /** Saves the external API listener config; it takes effect after a backend restart (`apiListener.pendingRestart`). */
  async setApiListener(update: ApiListenerUpdate): Promise<AgentCallingSettings> {
    return this.request('/v2/agent-calling/api-listener', { method: 'PUT', body: JSON.stringify(update) });
  }

  async listApiKeys(): Promise<{ keys: ApiKeySummary[] }> {
    return this.request('/v2/api-keys');
  }

  /** The result's `key` is the only time the full key is available. */
  async createApiKey(request: ApiKeyCreateRequest): Promise<ApiKeyCreated> {
    return this.request('/v2/api-keys', { method: 'POST', body: JSON.stringify(request) });
  }

  async updateApiKey(id: string, update: ApiKeyUpdate): Promise<ApiKeySummary> {
    return this.request(`/v2/api-keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) });
  }

  /** Revoked keys stay listed (status `revoked`); their running turns are cancelled. */
  async revokeApiKey(id: string): Promise<{ id: string; revoked: boolean }> {
    return this.request(`/v2/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async setSshHostAgentAccess(alias: string, enabled: boolean): Promise<{ alias: string; agentAccess: boolean }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/agent-access`, {
      method: 'PUT', body: JSON.stringify({ enabled }),
    });
  }

  /** With `password`, ssh answers one password prompt with it instead of only trying keys. */
  async testSshHost(alias: string, password?: string): Promise<SshTestResult> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/test`, {
      method: 'POST',
      ...(password ? { body: JSON.stringify({ password }) } : {}),
    });
  }

  async getSshSettings(): Promise<SshConnectionSettings> {
    return this.request('/v2/ssh/settings');
  }

  /** Applies to ssh processes started afterwards; open shared connections keep their options. */
  async setSshSettings(settings: SshConnectionSettings): Promise<SshConnectionSettings> {
    return this.request('/v2/ssh/settings', { method: 'PUT', body: JSON.stringify(settings) });
  }

  /** Older backends answer 404 (see `isNotFoundError`). */
  async getAgentOutputFilter(): Promise<AgentOutputFilter> {
    return this.request('/v2/ssh/agent-output-filter');
  }

  /**
   * Takes `enabled` and `categories`; left-out categories and `customKeys` keep
   * their saved value, unknown ones are rejected (see `fitAgentOutputFilter`).
   * Later `ssh_exec` results use it.
   */
  async setAgentOutputFilter(filter: AgentOutputFilter): Promise<AgentOutputFilter> {
    return this.request('/v2/ssh/agent-output-filter', { method: 'PUT', body: JSON.stringify(filter) });
  }

  /** Older backends answer 404 (see `isNotFoundError`). */
  async getAgentLocal(): Promise<AgentLocalTerminal> {
    return this.request('/v2/ssh/agent-local');
  }

  /** Takes the full setting (unknown fields are rejected); enabling applies from the next conversation start. */
  async setAgentLocal(settings: AgentLocalTerminal): Promise<AgentLocalTerminal> {
    return this.request('/v2/ssh/agent-local', { method: 'PUT', body: JSON.stringify(settings) });
  }

  /** Closes the shared OpenSSH master connection for the host. */
  async disconnectSshHost(alias: string): Promise<{ disconnected: boolean }> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/disconnect`, { method: 'POST' });
  }

  /** Answers an agent's `ssh.login.requested`: a password logs in (a shared
   * connection the waiting command reuses), none declines. */
  async answerSshLogin(alias: string, input: SshLoginAnswerInput): Promise<SshLoginAnswer> {
    return this.request(`/v2/ssh/hosts/${encodeURIComponent(alias)}/login`, { method: 'POST', body: JSON.stringify(input) });
  }

  // Port forwards (`/v2/ssh/forwards`). They never start on their own.

  async listSshForwards(): Promise<{ forwards: SshForward[] }> {
    return this.request('/v2/ssh/forwards');
  }

  async createSshForward(input: SshForwardInput): Promise<{ forward: SshForward }> {
    return this.request('/v2/ssh/forwards', { method: 'POST', body: JSON.stringify(input) });
  }

  /** 409 while the forward is starting or running. */
  async updateSshForward(id: string, input: SshForwardInput): Promise<{ forward: SshForward }> {
    return this.request(`/v2/ssh/forwards/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
  }

  async deleteSshForward(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/v2/ssh/forwards/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * Resolves once the forward runs or failed (the backend waits up to ~20 s);
   * runtime failures come back as `status: 'failed'` rather than an error.
   */
  async startSshForward(id: string, password?: string): Promise<{ forward: SshForward }> {
    return this.request(`/v2/ssh/forwards/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      ...(password ? { body: JSON.stringify({ password }) } : {}),
    }, Math.max(this.timeout, 30_000));
  }

  async stopSshForward(id: string): Promise<{ forward: SshForward }> {
    return this.request(`/v2/ssh/forwards/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  }

  // Loopback IP pool (`/v2/ssh/ip-pool`).

  async getSshIpPool(): Promise<SshIpPool> {
    return this.request('/v2/ssh/ip-pool');
  }

  /** 409 when the new CIDR drops an assigned IP; 501 when enabling on an unsupported platform. */
  async updateSshIpPool(config: SshIpPoolConfig): Promise<SshIpPool> {
    return this.request('/v2/ssh/ip-pool', { method: 'PUT', body: JSON.stringify(config) });
  }

  async createSshIpAssignment(input: SshIpAssignmentInput): Promise<{ assignment: SshIpAssignment }> {
    return this.request('/v2/ssh/ip-pool/assignments', { method: 'POST', body: JSON.stringify(input) });
  }

  async updateSshIpAssignment(ip: string, update: SshIpAssignmentUpdate): Promise<{ assignment: SshIpAssignment }> {
    return this.request(`/v2/ssh/ip-pool/assignments/${encodeURIComponent(ip)}`, { method: 'PUT', body: JSON.stringify(update) });
  }

  async deleteSshIpAssignment(ip: string): Promise<{ deleted: boolean }> {
    return this.request(`/v2/ssh/ip-pool/assignments/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  }

  /** Opens the assignment's dedicated ssh connection now; password hosts need this. */
  async connectSshIpAssignment(ip: string, password?: string): Promise<{ assignment: SshIpAssignment }> {
    return this.request(`/v2/ssh/ip-pool/assignments/${encodeURIComponent(ip)}/connect`, {
      method: 'POST',
      ...(password ? { body: JSON.stringify({ password }) } : {}),
    }, Math.max(this.timeout, 30_000));
  }

  async disconnectSshIpAssignment(ip: string): Promise<{ assignment: SshIpAssignment }> {
    return this.request(`/v2/ssh/ip-pool/assignments/${encodeURIComponent(ip)}/disconnect`, { method: 'POST' });
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

  /**
   * Writes one chunk of a prompt attachment (`PUT /v2/uploads`). The first
   * chunk (offset 0, no `uploadId`) starts a new upload; later chunks pass
   * the returned `uploadId` and start where the stored file ends.
   */
  async uploadPromptChunk(
    name: string,
    offset: number,
    bytes: Uint8Array,
    uploadId?: string,
    timeoutMs = 10 * 60_000,
  ): Promise<PromptUploadChunkResult> {
    const query = new URLSearchParams({ name, offset: String(offset) });
    if (uploadId) query.set('uploadId', uploadId);
    return this.request(`/v2/uploads?${query}`, {
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
        // Only 401 / UNAUTHENTICATED means "not paired"; 403 / UNAUTHORIZED is
        // a permission refusal whose server message must reach the user.
        if (isAuthenticationFailure(response.status, backendCode)) {
          throw ConnectionError.authenticationFailed(response.status);
        }
        throw ConnectionError.apiRequestFailed(
          response.status,
          backendCode,
          backendMessage,
        );
      }

      if (responseType === 'bytes') return response.body as T;
      // `204 No Content` (e.g. deleting an instruction preset) or an empty
      // 2xx body has nothing to parse.
      if (response.status === 204 || response.body.length === 0) return undefined as T;
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
