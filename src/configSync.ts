import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ConnectionError } from './connectionError';
import { fitAgentOutputFilter, type AgentOutputFilter, type ManagedHost, type SshKey } from './ssh';
import {
  AGENT_PROVIDER_TRANSFER_FORMAT,
  MANAGED_PROVIDER_AGENTS,
  type CliSettingsProvider,
  type InstructionPreset,
  type ManagedProviderAgent,
  type ProviderKind,
  type SkillBundleFile,
  type SkillCatalogDescriptor,
  type V2ApiClient,
} from './v2';

/**
 * One-way, incremental configuration sync between two paired backends.
 *
 * The client reads the source backend, reads the target backend, and writes
 * only items whose content differs. Items are matched by portable keys (agent +
 * provider id, CLI + MCP name, skill source + name, SSH alias, ...), never by
 * backend resource ids, which hash host paths. A per-pair baseline of content
 * hashes from the last sync tells "only the source changed" apart from "the
 * target was edited too", so target-side edits are never overwritten silently.
 * Nothing is ever deleted on the target. SSH sync carries managed key-auth
 * hosts only; private keys never leave a backend, so the target must already
 * hold a key with the same fingerprint.
 */

export const CONFIG_SYNC_CATEGORIES = ['accounts', 'settings', 'mcp', 'skills', 'ssh'] as const;

export type ConfigSyncCategory = (typeof CONFIG_SYNC_CATEGORIES)[number];

export type ConfigSyncItemKind =
  | 'agentProvider'
  | 'sshSettings'
  | 'outputFilter'
  | 'agentLocal'
  | 'historyCleanup'
  | 'instructionPreset'
  | 'cliInstructions'
  | 'cliSetting'
  | 'mcpServer'
  | 'skill'
  | 'sshHost';

export type ConfigSyncWarning =
  /** The config names a path under a user's home directory, which may not exist on the target. */
  | 'absolutePath'
  /** Symlinks or special files in the skill directory are not synced. */
  | 'skillFilesSkipped'
  /** The source daemon predates skill bundles; only `SKILL.md` is synced. */
  | 'skillContentOnly';

export type ConfigSyncBlockCode =
  /** Password-auth hosts are never synced. */
  | 'passwordAuth'
  /** The source host's identity file is not a key the source backend lists. */
  | 'unknownIdentity'
  /** The target has no private key with the host key's fingerprint. */
  | 'missingKey';

export type ConfigSyncBlock = { code: ConfigSyncBlockCode; detail?: string };

export type ConfigSyncItem = {
  /** Portable identity, stable across backends. */
  key: string;
  category: ConfigSyncCategory;
  kind: ConfigSyncItemKind;
  /** Agent, CLI or provider the item belongs to; empty for backend-wide items. */
  group: string;
  /** User-visible name: provider, preset, MCP server, skill or host name, or a settings key. */
  label: string;
  /** Content hash; secrets are only ever hashed, never stored. */
  hash: string;
  /** What `applyConfigSync` writes. Holds secrets in clear: keep in memory only. */
  payload: unknown;
  warnings: ConfigSyncWarning[];
  blocked?: ConfigSyncBlock;
};

export type ConfigSyncError = { category: ConfigSyncCategory; scope: string; message: string };

export type ConfigSyncSnapshot = {
  categories: ConfigSyncCategory[];
  items: ConfigSyncItem[];
  errors: ConfigSyncError[];
  /** Keys on this backend, used to check that a synced host's key exists. */
  sshKeys?: SshKey[];
};

export type ConfigSyncApi = Pick<
  V2ApiClient,
  | 'exportAgentProviders'
  | 'importAgentProviders'
  | 'getSshSettings'
  | 'setSshSettings'
  | 'getAgentOutputFilter'
  | 'setAgentOutputFilter'
  | 'getAgentLocal'
  | 'setAgentLocal'
  | 'getHistoryCleanupPolicy'
  | 'updateHistoryCleanupPolicy'
  | 'listInstructionPresets'
  | 'createInstructionPreset'
  | 'updateInstructionPreset'
  | 'getCliInstructions'
  | 'writeCliInstructions'
  | 'setCliInstructionsSource'
  | 'getCliSettings'
  | 'patchCliSettings'
  | 'listMcpCatalog'
  | 'getMcpServerConfig'
  | 'createMcpServer'
  | 'updateMcpServer'
  | 'listSkillCatalog'
  | 'getSkillResource'
  | 'getSkillBundle'
  | 'replaceSkillBundle'
  | 'createSkillBundle'
  | 'createSkill'
  | 'updateSkill'
  | 'listSshHosts'
  | 'listSshKeys'
  | 'createSshHost'
  | 'updateSshHost'
>;

export type ConfigSyncBackend = {
  api: ConfigSyncApi;
  /** A workspace path that exists on this backend; catalog routes require one even for user scope. */
  workspace: string;
};

/** Providers whose user-scope MCP servers and skills are synced. */
export const CONFIG_SYNC_CATALOG_PROVIDERS: ProviderKind[] = [
  'claude-code',
  'codex',
  'pi',
  'devin',
  'antigravity',
  'deepseek-harness',
];

/** CLIs whose settings file and global instructions are synced. DeepSeek Harness's
 * settings are a YAML patch layer owned by its accounts and MCP rows, so only its
 * instructions sync. */
const INSTRUCTION_PROVIDERS: CliSettingsProvider[] = ['claude-code', 'codex', 'pi', 'deepseek-harness'];
const SETTINGS_FILE_PROVIDERS: CliSettingsProvider[] = ['claude-code', 'codex', 'pi'];

/**
 * Settings-file keys left alone: account fields (owned by CLI account profiles)
 * and MCP tables (synced as MCP servers), plus host-specific state.
 */
export const CLI_SETTINGS_EXCLUDED_KEYS: Record<CliSettingsProvider, readonly string[]> = {
  'claude-code': ['env', 'model', 'apiKeyHelper', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'],
  codex: ['model', 'model_provider', 'model_providers', 'profile', 'profiles', 'mcp_servers', 'projects'],
  pi: ['defaultProvider', 'defaultModel', 'packages'],
  'deepseek-harness': [],
};

// --- Hashing ---------------------------------------------------------------

/** JSON with object keys sorted and `undefined` dropped, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function configSyncHash(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(`todex.config-sync.v1\0${canonicalJson(value)}`)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * RFC 7386 merge patch turning `from` into `to`: removed keys become `null`,
 * nested objects are diffed, anything else is replaced.
 */
export function mergePatchBetween(from: unknown, to: unknown): unknown {
  if (!isPlainObject(from) || !isPlainObject(to)) return to;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(from)) {
    if (!(key in to)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(to)) {
    if (canonicalJson(from[key]) === canonicalJson(value)) continue;
    patch[key] = key in from ? mergePatchBetween(from[key], value) : value;
  }
  return patch;
}

const HOME_PATH = /^(?:\/home\/|\/Users\/|\/root(?:\/|$)|[A-Za-z]:[\\/]Users[\\/])/;

/** True when any string in `value` is an absolute path under a user's home directory. */
export function mentionsHomePath(value: unknown): boolean {
  if (typeof value === 'string') return HOME_PATH.test(value);
  if (Array.isArray(value)) return value.some(mentionsHomePath);
  if (isPlainObject(value)) return Object.values(value).some(mentionsHomePath);
  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConnectionError) return error.userMessage || error.message;
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ConnectionError && (error.httpStatus === 404 || error.httpStatus === 405);
}

function utf8ToBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function item(
  category: ConfigSyncCategory,
  kind: ConfigSyncItemKind,
  key: string,
  group: string,
  label: string,
  hashed: unknown,
  payload: unknown,
  warnings: ConfigSyncWarning[] = [],
  blocked?: ConfigSyncBlock,
): ConfigSyncItem {
  return { key, category, kind, group, label, hash: configSyncHash(hashed), payload, warnings, ...(blocked ? { blocked } : {}) };
}

// --- Payloads ----------------------------------------------------------------

type ProviderPayload = { agent: ManagedProviderAgent; provider: Record<string, unknown> & { id: string } };
type ValuePayload = { value: unknown };
type PresetPayload = { name: string; text: string };
type InstructionsPayload = { provider: CliSettingsProvider; text: string; presetName: string | null };
type CliSettingPayload = { provider: CliSettingsProvider; key: string; value: unknown };
type McpPayload = { provider: ProviderKind; name: string; config: unknown };
type SkillPayload = { provider: ProviderKind; source: string; name: string; files: SkillBundleFile[]; contentOnly: boolean };
type SshHostPayload = { host: ManagedHost; fingerprint: string | null };

// --- Collect ------------------------------------------------------------------

type Collector = (backend: ConfigSyncBackend, snapshot: ConfigSyncSnapshot) => Promise<void>;

async function attempt(
  snapshot: ConfigSyncSnapshot,
  category: ConfigSyncCategory,
  scope: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    // A route the daemon does not have is a category it cannot sync, not a failure.
    if (isNotFound(error)) return;
    snapshot.errors.push({ category, scope, message: errorMessage(error) });
  }
}

const collectAccounts: Collector = async ({ api }, snapshot) => {
  for (const agent of MANAGED_PROVIDER_AGENTS) {
    await attempt(snapshot, 'accounts', agent, async () => {
      const transfer = await api.exportAgentProviders(agent);
      for (const provider of transfer.providers) {
        snapshot.items.push(item(
          'accounts', 'agentProvider', `accounts:${agent}:${provider.id}`, agent, provider.name,
          provider, { agent, provider } satisfies ProviderPayload,
        ));
      }
    });
  }
};

const collectSettings: Collector = async ({ api }, snapshot) => {
  const backendWide: Array<[ConfigSyncItemKind, () => Promise<unknown>]> = [
    ['sshSettings', () => api.getSshSettings()],
    ['outputFilter', () => api.getAgentOutputFilter()],
    ['agentLocal', () => api.getAgentLocal()],
    ['historyCleanup', async () => (await api.getHistoryCleanupPolicy()).policy],
  ];
  for (const [kind, read] of backendWide) {
    await attempt(snapshot, 'settings', kind, async () => {
      const value = await read();
      snapshot.items.push(item('settings', kind, `settings:${kind}`, '', kind, value, { value } satisfies ValuePayload));
    });
  }

  let presets: InstructionPreset[] = [];
  await attempt(snapshot, 'settings', 'instructionPresets', async () => {
    presets = (await api.listInstructionPresets()).presets;
    const seen = new Set<string>();
    for (const preset of presets) {
      if (seen.has(preset.name)) continue;
      seen.add(preset.name);
      const payload: PresetPayload = { name: preset.name, text: preset.text };
      snapshot.items.push(item('settings', 'instructionPreset', `settings:preset:${preset.name}`, '', preset.name, payload, payload));
    }
  });

  for (const provider of INSTRUCTION_PROVIDERS) {
    await attempt(snapshot, 'settings', `${provider} instructions`, async () => {
      const document = await api.getCliInstructions(provider);
      if (!document.exists) return;
      const preset = document.presetId && !document.drifted
        ? presets.find(candidate => candidate.id === document.presetId)
        : undefined;
      const payload: InstructionsPayload = { provider, text: document.text, presetName: preset?.name ?? null };
      snapshot.items.push(item(
        'settings', 'cliInstructions', `settings:instructions:${provider}`, provider, provider,
        { text: payload.text, presetName: payload.presetName }, payload,
      ));
    });
  }

  for (const provider of SETTINGS_FILE_PROVIDERS) {
    await attempt(snapshot, 'settings', `${provider} settings`, async () => {
      const document = await api.getCliSettings(provider);
      if (!document.exists) return;
      if (!document.settings) throw new Error(document.parseError ?? `${document.path} does not parse`);
      const excluded = new Set(CLI_SETTINGS_EXCLUDED_KEYS[provider]);
      for (const [key, value] of Object.entries(document.settings)) {
        if (excluded.has(key)) continue;
        const payload: CliSettingPayload = { provider, key, value };
        snapshot.items.push(item(
          'settings', 'cliSetting', `settings:cli:${provider}:${key}`, provider, key, value, payload,
          mentionsHomePath(value) ? ['absolutePath'] : [],
        ));
      }
    });
  }
};

const collectMcp: Collector = async ({ api, workspace }, snapshot) => {
  for (const provider of CONFIG_SYNC_CATALOG_PROVIDERS) {
    await attempt(snapshot, 'mcp', provider, async () => {
      const catalog = await api.listMcpCatalog(provider, workspace);
      if (catalog.editable === false) return;
      const seen = new Set<string>();
      for (const server of catalog.servers) {
        if (server.scope !== 'user' || seen.has(server.name)) continue;
        seen.add(server.name);
        const { config } = await api.getMcpServerConfig(provider, workspace, server.resourceId);
        const payload: McpPayload = { provider, name: server.name, config };
        snapshot.items.push(item(
          'mcp', 'mcpServer', `mcp:${provider}:${server.name}`, provider, server.name, config, payload,
          mentionsHomePath(config) ? ['absolutePath'] : [],
        ));
      }
    });
  }
};

const SYNCED_SKILL_SOURCES = new Set(['shared-user', 'provider-user']);

function skillKey(provider: ProviderKind, skill: { source: string; name: string }): string {
  // Shared skills live in one directory every provider lists.
  return skill.source === 'shared-user' ? `skills:shared:${skill.name}` : `skills:${provider}:${skill.name}`;
}

function sortedFiles(files: SkillBundleFile[]): SkillBundleFile[] {
  return [...files]
    .map(file => ({ path: file.path, contentBase64: file.contentBase64, executable: Boolean(file.executable) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

const collectSkills: Collector = async ({ api, workspace }, snapshot) => {
  const seen = new Set<string>();
  for (const provider of CONFIG_SYNC_CATALOG_PROVIDERS) {
    await attempt(snapshot, 'skills', provider, async () => {
      const catalog = await api.listSkillCatalog(provider, workspace);
      if (catalog.editable === false) return;
      for (const skill of catalog.skills) {
        // Built-in skills are reinstalled by their CLI; copying them would fork its copy.
        if (skill.scope !== 'user' || skill.builtIn || !SYNCED_SKILL_SOURCES.has(skill.source)) continue;
        const key = skillKey(provider, skill);
        if (seen.has(key)) continue;
        seen.add(key);
        const warnings: ConfigSyncWarning[] = [];
        let files: SkillBundleFile[];
        let contentOnly = false;
        try {
          const bundle = await api.getSkillBundle(provider, workspace, skill.resourceId);
          files = bundle.files;
          if (bundle.skipped?.length) warnings.push('skillFilesSkipped');
        } catch (error) {
          if (!isNotFound(error)) throw error;
          const { content } = await api.getSkillResource(provider, workspace, skill.resourceId);
          files = [{ path: 'SKILL.md', contentBase64: utf8ToBase64(content) }];
          contentOnly = true;
          warnings.push('skillContentOnly');
        }
        files = sortedFiles(files);
        const payload: SkillPayload = { provider, source: skill.source, name: skill.name, files, contentOnly };
        snapshot.items.push(item(
          'skills', 'skill', key, skill.source === 'shared-user' ? 'shared' : provider, skill.name,
          files, payload, warnings,
        ));
      }
    });
  }
};

function keyForHost(alias: string, identityFile: string | undefined, keys: SshKey[]): SshKey | undefined {
  const withPrivate = keys.filter(key => key.privateKeyPath);
  const byUse = withPrivate.find(key => key.usedBy.includes(alias));
  if (byUse) return byUse;
  if (!identityFile) return undefined;
  const base = identityFile.split(/[\\/]/).pop();
  return withPrivate.find(key => key.privateKeyPath === identityFile || key.name === base);
}

const collectSsh: Collector = async ({ api }, snapshot) => {
  await attempt(snapshot, 'ssh', 'hosts', async () => {
    const [{ hosts }, { keys }] = await Promise.all([api.listSshHosts(), api.listSshKeys()]);
    snapshot.sshKeys = keys;
    for (const host of hosts) {
      const managed = host.managed;
      if (host.source !== 'managed' || !managed) continue;
      const key = `ssh:${managed.alias}`;
      if (managed.authMethod === 'password') {
        snapshot.items.push(item('ssh', 'sshHost', key, '', managed.alias, null, null, [], { code: 'passwordAuth' }));
        continue;
      }
      const { identityFile, ...portable } = managed;
      const identity = identityFile ? keyForHost(managed.alias, identityFile, keys) : undefined;
      const fingerprint = identity?.fingerprint ?? null;
      const payload: SshHostPayload = { host: managed, fingerprint };
      // Hosts compare by key fingerprint, not by path: each backend has its own `~/.ssh`.
      snapshot.items.push(item(
        'ssh', 'sshHost', key, '', managed.alias, { ...portable, authMethod: 'key', identity: fingerprint }, payload, [],
        identityFile && !identity ? { code: 'unknownIdentity', detail: identityFile } : undefined,
      ));
    }
  });
};

const COLLECTORS: Record<ConfigSyncCategory, Collector> = {
  accounts: collectAccounts,
  settings: collectSettings,
  mcp: collectMcp,
  skills: collectSkills,
  ssh: collectSsh,
};

/** Reads every syncable item of `categories` from one backend. */
export async function collectConfigSync(
  backend: ConfigSyncBackend,
  categories: readonly ConfigSyncCategory[],
): Promise<ConfigSyncSnapshot> {
  const snapshot: ConfigSyncSnapshot = { categories: [...categories], items: [], errors: [] };
  for (const category of CONFIG_SYNC_CATEGORIES) {
    if (categories.includes(category)) await COLLECTORS[category](backend, snapshot);
  }
  return snapshot;
}

// --- Plan ---------------------------------------------------------------------

/**
 * - `new`: missing on the target.
 * - `update`: only the source changed since the last sync (or there was none).
 * - `same`: nothing to write.
 * - `targetChanged`: only the target changed (or was deleted there) since the last sync.
 * - `conflict`: both changed since the last sync.
 * - `blocked`: cannot be synced (`blocked` says why).
 */
export type ConfigSyncStatus = 'new' | 'update' | 'same' | 'targetChanged' | 'conflict' | 'blocked';

export type ConfigSyncEntry = {
  key: string;
  category: ConfigSyncCategory;
  kind: ConfigSyncItemKind;
  group: string;
  label: string;
  status: ConfigSyncStatus;
  source: ConfigSyncItem;
  targetHash?: string;
  warnings: ConfigSyncWarning[];
  blocked?: ConfigSyncBlock;
  /** Whether the entry starts selected: only `new` and `update`. */
  selected: boolean;
};

/** Content hashes of each key on both sides right after its last sync. */
export type ConfigSyncBaseline = Record<string, { source: string; target: string }>;

export function isConfigSyncSelectable(status: ConfigSyncStatus): boolean {
  return status !== 'same' && status !== 'blocked';
}

function targetBlock(source: ConfigSyncItem, target: ConfigSyncSnapshot): ConfigSyncBlock | undefined {
  if (source.blocked) return source.blocked;
  if (source.kind === 'sshHost') {
    const { fingerprint } = source.payload as SshHostPayload;
    if (fingerprint && !target.sshKeys?.some(key => key.fingerprint === fingerprint && key.privateKeyPath)) {
      return { code: 'missingKey', detail: fingerprint };
    }
  }
  return undefined;
}

function statusOf(
  source: ConfigSyncItem,
  targetHash: string | undefined,
  base: { source: string; target: string } | undefined,
): ConfigSyncStatus {
  if (targetHash === source.hash) return 'same';
  if (targetHash === undefined) return base ? 'targetChanged' : 'new';
  if (!base) return 'update';
  const sourceChanged = source.hash !== base.source;
  const targetChanged = targetHash !== base.target;
  if (sourceChanged && targetChanged) return 'conflict';
  if (targetChanged) return 'targetChanged';
  if (sourceChanged) return 'update';
  // Neither side changed since the sync that left them unequal (the target
  // normalized what it was given): nothing new to write.
  return 'same';
}

/** Compares the two sides, in source order. Target-only items are left out: sync never deletes. */
export function planConfigSync(
  source: ConfigSyncSnapshot,
  target: ConfigSyncSnapshot,
  baseline: ConfigSyncBaseline = {},
): ConfigSyncEntry[] {
  const targetHashes = new Map(target.items.map(entry => [entry.key, entry.hash]));
  return source.items.map((sourceItem) => {
    const blocked = targetBlock(sourceItem, target);
    const targetHash = targetHashes.get(sourceItem.key);
    const status = blocked ? 'blocked' : statusOf(sourceItem, targetHash, baseline[sourceItem.key]);
    return {
      key: sourceItem.key,
      category: sourceItem.category,
      kind: sourceItem.kind,
      group: sourceItem.group,
      label: sourceItem.label,
      status,
      source: sourceItem,
      ...(targetHash === undefined ? {} : { targetHash }),
      warnings: sourceItem.warnings,
      ...(blocked ? { blocked } : {}),
      selected: status === 'new' || status === 'update',
    };
  });
}

// --- Apply --------------------------------------------------------------------

export type ConfigSyncResult = { key: string; ok: boolean; error?: string };

/** Lazily read target state shared by the writes of one apply run. */
class TargetState {
  private presets?: Promise<InstructionPreset[]>;
  private mcp = new Map<ProviderKind, ReturnType<ConfigSyncApi['listMcpCatalog']>>();
  private skills = new Map<ProviderKind, ReturnType<ConfigSyncApi['listSkillCatalog']>>();
  private hosts?: ReturnType<ConfigSyncApi['listSshHosts']>;
  private keys?: ReturnType<ConfigSyncApi['listSshKeys']>;

  constructor(private readonly backend: ConfigSyncBackend) {}

  listPresets(refresh = false) {
    if (refresh || !this.presets) this.presets = this.backend.api.listInstructionPresets().then(response => response.presets);
    return this.presets;
  }

  mcpCatalog(provider: ProviderKind) {
    let catalog = this.mcp.get(provider);
    if (!catalog) {
      catalog = this.backend.api.listMcpCatalog(provider, this.backend.workspace);
      this.mcp.set(provider, catalog);
    }
    return catalog;
  }

  skillCatalog(provider: ProviderKind) {
    let catalog = this.skills.get(provider);
    if (!catalog) {
      catalog = this.backend.api.listSkillCatalog(provider, this.backend.workspace);
      this.skills.set(provider, catalog);
    }
    return catalog;
  }

  sshHosts() {
    this.hosts ??= this.backend.api.listSshHosts();
    return this.hosts;
  }

  sshKeys() {
    this.keys ??= this.backend.api.listSshKeys();
    return this.keys;
  }
}

async function applyValue(api: ConfigSyncApi, kind: ConfigSyncItemKind, value: unknown): Promise<void> {
  switch (kind) {
    case 'sshSettings': await api.setSshSettings(value as Parameters<ConfigSyncApi['setSshSettings']>[0]); return;
    case 'outputFilter': {
      // An older target rejects categories and fields it does not know.
      const target = await api.getAgentOutputFilter();
      await api.setAgentOutputFilter(fitAgentOutputFilter(value as AgentOutputFilter, target));
      return;
    }
    case 'agentLocal': await api.setAgentLocal(value as Parameters<ConfigSyncApi['setAgentLocal']>[0]); return;
    case 'historyCleanup': await api.updateHistoryCleanupPolicy(value as Parameters<ConfigSyncApi['updateHistoryCleanupPolicy']>[0]); return;
    default: throw new Error(`unsupported settings item ${kind}`);
  }
}

async function applyPreset(api: ConfigSyncApi, state: TargetState, payload: PresetPayload): Promise<void> {
  const existing = (await state.listPresets()).find(preset => preset.name === payload.name);
  if (existing) await api.updateInstructionPreset(existing.id, existing.revision, payload.name, payload.text);
  else await api.createInstructionPreset(payload.name, payload.text);
}

async function applyInstructions(api: ConfigSyncApi, state: TargetState, payload: InstructionsPayload): Promise<void> {
  const document = await api.getCliInstructions(payload.provider);
  // Presets are applied first, so a preset synced in this run is found here.
  const preset = payload.presetName
    ? (await state.listPresets(true)).find(candidate => candidate.name === payload.presetName)
    : undefined;
  if (preset && preset.text === payload.text) {
    await api.setCliInstructionsSource(payload.provider, document.revision, preset.id);
  } else {
    await api.writeCliInstructions(payload.provider, document.revision, payload.text);
  }
}

async function applyCliSetting(api: ConfigSyncApi, payload: CliSettingPayload): Promise<void> {
  const document = await api.getCliSettings(payload.provider);
  if (document.exists && !document.settings) {
    throw new Error(document.parseError ?? `${document.path} does not parse`);
  }
  const current = document.settings?.[payload.key];
  const patch = current === undefined ? payload.value : mergePatchBetween(current, payload.value);
  await api.patchCliSettings(payload.provider, document.revision, { [payload.key]: patch });
}

async function applyMcp(backend: ConfigSyncBackend, state: TargetState, payload: McpPayload): Promise<void> {
  const { api, workspace } = backend;
  const catalog = await state.mcpCatalog(payload.provider);
  const existing = catalog.servers.find(server => server.scope === 'user' && server.name === payload.name);
  if (existing) {
    await api.updateMcpServer(payload.provider, workspace, existing.resourceId, { name: payload.name, config: payload.config });
  } else {
    await api.createMcpServer(payload.provider, workspace, { scope: 'user', name: payload.name, config: payload.config });
  }
}

function skillMarkdown(files: SkillBundleFile[]): string | undefined {
  const file = files.find(candidate => candidate.path === 'SKILL.md');
  return file ? base64ToUtf8(file.contentBase64) : undefined;
}

export class ConfigSyncTargetOutdatedError extends Error {
  constructor() {
    super('The target backend cannot store skill files besides SKILL.md; update it to sync this skill.');
    this.name = 'ConfigSyncTargetOutdatedError';
  }
}

async function applySkill(backend: ConfigSyncBackend, state: TargetState, payload: SkillPayload): Promise<void> {
  const { api, workspace } = backend;
  const catalog = await state.skillCatalog(payload.provider);
  const existing: SkillCatalogDescriptor | undefined = catalog.skills.find(
    skill => skill.scope === 'user' && skill.source === payload.source && skill.name === payload.name,
  );
  const markdownOnly = () => {
    const content = skillMarkdown(payload.files);
    if (content === undefined || payload.files.length !== 1) throw new ConfigSyncTargetOutdatedError();
    return content;
  };
  try {
    if (existing) await api.replaceSkillBundle(payload.provider, workspace, existing.resourceId, payload.files);
    else await api.createSkillBundle(payload.provider, workspace, { source: payload.source, name: payload.name, files: payload.files });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (existing) await api.updateSkill(payload.provider, workspace, existing.resourceId, markdownOnly());
    else await api.createSkill(payload.provider, workspace, { source: payload.source, name: payload.name, content: markdownOnly() });
  }
}

async function applySshHost(api: ConfigSyncApi, state: TargetState, payload: SshHostPayload): Promise<void> {
  const host: ManagedHost = { ...payload.host, authMethod: 'key' };
  delete host.identityFile;
  if (payload.fingerprint) {
    const { keys } = await state.sshKeys();
    const key = keys.find(candidate => candidate.fingerprint === payload.fingerprint && candidate.privateKeyPath);
    if (!key?.privateKeyPath) throw new Error(`No key with fingerprint ${payload.fingerprint} on the target`);
    host.identityFile = key.privateKeyPath;
  }
  const { hosts } = await state.sshHosts();
  const existing = hosts.find(candidate => candidate.alias === host.alias);
  if (existing && existing.source !== 'managed') {
    throw new Error(`"${host.alias}" is defined in the target's ~/.ssh/config`);
  }
  if (existing) await api.updateSshHost(host.alias, host);
  else await api.createSshHost(host);
}

/** Write order: presets before the instructions that follow them. */
const KIND_ORDER: ConfigSyncItemKind[] = [
  'agentProvider', 'sshSettings', 'outputFilter', 'agentLocal', 'historyCleanup',
  'instructionPreset', 'cliInstructions', 'cliSetting', 'mcpServer', 'skill', 'sshHost',
];

/**
 * Writes `entries` to the target, one at a time; a failure is reported per
 * entry and never stops the rest. Account profiles are imported per agent in
 * one request (upsert by id, current selection kept).
 */
export async function applyConfigSync(
  target: ConfigSyncBackend,
  entries: readonly ConfigSyncEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<ConfigSyncResult[]> {
  const { api } = target;
  const state = new TargetState(target);
  const ordered = [...entries]
    .filter(entry => isConfigSyncSelectable(entry.status))
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
  const results: ConfigSyncResult[] = [];
  let done = 0;
  const report = (keys: string[], error?: unknown) => {
    for (const key of keys) {
      results.push(error === undefined ? { key, ok: true } : { key, ok: false, error: errorMessage(error) });
    }
    done += keys.length;
    onProgress?.(done, ordered.length);
  };

  const providerGroups = new Map<ManagedProviderAgent, ConfigSyncEntry[]>();
  for (const entry of ordered) {
    if (entry.kind !== 'agentProvider') continue;
    const { agent } = entry.source.payload as ProviderPayload;
    providerGroups.set(agent, [...(providerGroups.get(agent) ?? []), entry]);
  }
  for (const [agent, group] of providerGroups) {
    try {
      await api.importAgentProviders(agent, {
        format: AGENT_PROVIDER_TRANSFER_FORMAT,
        version: 1,
        agent,
        exportedAt: Date.now(),
        providers: group.map(entry => (entry.source.payload as ProviderPayload).provider) as never,
      });
      report(group.map(entry => entry.key));
    } catch (error) {
      report(group.map(entry => entry.key), error);
    }
  }

  for (const entry of ordered) {
    if (entry.kind === 'agentProvider') continue;
    const payload = entry.source.payload;
    try {
      switch (entry.kind) {
        case 'sshSettings':
        case 'outputFilter':
        case 'agentLocal':
        case 'historyCleanup':
          await applyValue(api, entry.kind, (payload as ValuePayload).value);
          break;
        case 'instructionPreset': await applyPreset(api, state, payload as PresetPayload); break;
        case 'cliInstructions': await applyInstructions(api, state, payload as InstructionsPayload); break;
        case 'cliSetting': await applyCliSetting(api, payload as CliSettingPayload); break;
        case 'mcpServer': await applyMcp(target, state, payload as McpPayload); break;
        case 'skill': await applySkill(target, state, payload as SkillPayload); break;
        case 'sshHost': await applySshHost(api, state, payload as SshHostPayload); break;
      }
      report([entry.key]);
    } catch (error) {
      report([entry.key], error);
    }
  }
  return results;
}

/**
 * The baseline after a sync: written and already-equal keys record both
 * sides' hashes (the target's as re-read after writing); every other key keeps
 * its previous record.
 */
export function nextConfigSyncBaseline(
  previous: ConfigSyncBaseline,
  entries: readonly ConfigSyncEntry[],
  results: readonly ConfigSyncResult[],
  targetAfter: ConfigSyncSnapshot,
): ConfigSyncBaseline {
  const next: ConfigSyncBaseline = { ...previous };
  const written = new Set(results.filter(result => result.ok).map(result => result.key));
  const targetHashes = new Map(targetAfter.items.map(entry => [entry.key, entry.hash]));
  for (const entry of entries) {
    if (entry.status !== 'same' && !written.has(entry.key)) continue;
    const targetHash = targetHashes.get(entry.key);
    if (targetHash === undefined) continue;
    next[entry.key] = { source: entry.source.hash, target: targetHash };
  }
  return next;
}
