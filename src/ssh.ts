import { ConnectionError } from './connectionError';

/**
 * SSH hosts, keys and remote file connections served by `todex-agentd`
 * (`/v2/ssh/*`, `/v2/ftp/*`, `/v2/remote/*`). Every host and key belongs to the
 * machine running the backend, never to the client. Passwords and key
 * passphrases are sent per request and are never persisted by the backend;
 * a client may keep a host password in the OS keychain.
 */

export type SshHostSource = 'sshConfig' | 'managed';

export type SshHostOption = { key: string; value: string };

/** `password` hosts skip keys and ask for a password; absent means `key`. */
export type SshAuthMethod = 'key' | 'password';

/** Editable definition of a TodeX-managed host (`$DATA_DIR/ssh/hosts.conf`). */
export type ManagedHost = {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  options?: SshHostOption[];
  authMethod?: SshAuthMethod;
};

export type SshResolvedHost = {
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
  identityFiles: string[];
};

export type SshHost = {
  alias: string;
  source: SshHostSource;
  /** Config file defining the host (`sshConfig` hosts only). */
  sourcePath?: string;
  /** Agents may run commands on this host without approval. Off by default. */
  agentAccess: boolean;
  resolved?: SshResolvedHost;
  resolveError?: string;
  /** Present for `managed` hosts only. */
  managed?: ManagedHost;
};

export type FtpProtocol = 'ftp' | 'ftps';

export type FtpSite = {
  id: string;
  name: string;
  protocol: FtpProtocol;
  host: string;
  port: number;
  user?: string;
  initialDirectory?: string;
};

export type FtpSiteInput = Omit<FtpSite, 'id' | 'port'> & { port?: number };

export type SshHostsResponse = {
  hosts: SshHost[];
  ftpSites: FtpSite[];
  /**
   * The backend runs on Linux or macOS and opens a terminal on
   * `LOCAL_TERMINAL_HOST` (`ssh localhost`, needs its sshd). Absent on
   * older backends.
   */
  localTerminal?: boolean;
};

export type SshHostImportResult = { hosts: ManagedHost[]; errors: string[] };

/**
 * Connection defaults for every backend ssh run (`/v2/ssh/settings`). A
 * value the backend user set for a host in `~/.ssh/config` still wins.
 */
export type SshConnectionSettings = {
  serverAliveEnabled: boolean;
  /** Seconds between keepalive probes; kept while disabled. */
  serverAliveInterval: number;
  /** Unanswered probes before ssh closes the connection. */
  serverAliveCountMax: number;
};

/**
 * Kinds of secrets the backend redacts by default from `ssh_exec` output
 * before it reaches the agent, in display order.
 */
export const AGENT_OUTPUT_FILTER_STANDARD_CATEGORIES = ['privateKey', 'publicKey', 'credential', 'bankCard', 'idCard', 'proxyCredential'] as const;

/**
 * Aggressive categories, off by default: they match by shape alone and also
 * hide values that are not secrets. Older backends lack them.
 */
export const AGENT_OUTPUT_FILTER_AGGRESSIVE_CATEGORIES = ['urlToken', 'highEntropy', 'uuid', 'email', 'phone', 'publicIp'] as const;

/** Every category, in display order. */
export const AGENT_OUTPUT_FILTER_CATEGORIES = [
  ...AGENT_OUTPUT_FILTER_STANDARD_CATEGORIES,
  ...AGENT_OUTPUT_FILTER_AGGRESSIVE_CATEGORIES,
] as const;

export type AgentOutputFilterCategory = (typeof AGENT_OUTPUT_FILTER_CATEGORIES)[number];

/** A backend reports only the categories it knows; show and send only those. */
export type AgentOutputFilterCategories = Partial<Record<AgentOutputFilterCategory, boolean>>;

/** Custom key names: at most this many, each 1–64 of `[A-Za-z0-9_.-]`. */
export const AGENT_OUTPUT_FILTER_CUSTOM_KEYS_LIMIT = 32;

export function isValidAgentOutputFilterKey(key: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(key);
}

/**
 * Privacy filter for command output returned to agents
 * (`/v2/ssh/agent-output-filter`). The user's own terminal and the live
 * `ssh.exec.output` stream stay unfiltered. Best effort, not a security
 * boundary. `PUT` keeps the saved value of a category or `customKeys` it
 * leaves out, but rejects ones the backend does not know.
 */
export type AgentOutputFilter = {
  enabled: boolean;
  categories: AgentOutputFilterCategories;
  /** Extra key names whose values are hidden like passwords; absent on older backends. */
  customKeys?: string[];
};

/**
 * `filter` cut down to what `target` (a backend's current setting) knows,
 * so it can be sent to that backend: unknown categories and, on backends
 * without them, custom keys are left out.
 */
export function fitAgentOutputFilter(filter: AgentOutputFilter, target: AgentOutputFilter): AgentOutputFilter {
  const known = new Set(Object.keys(target.categories ?? {}));
  const categories: AgentOutputFilterCategories = {};
  for (const [category, enabled] of Object.entries(filter.categories ?? {})) {
    if (known.has(category)) categories[category as AgentOutputFilterCategory] = enabled;
  }
  return {
    enabled: filter.enabled,
    categories,
    ...(target.customKeys !== undefined && filter.customKeys !== undefined ? { customKeys: filter.customKeys } : {}),
  };
}

/** Alias of the backend-machine host agents get when the local terminal is on. */
export const AGENT_LOCAL_HOST = 'Local';

/**
 * Terminal host that `terminal.start` with `ssh: { host }` opens on the
 * backend's own machine over `ssh localhost`; it shadows an inventory host of
 * the same name, as `AGENT_LOCAL_HOST` does for agents.
 */
export const LOCAL_TERMINAL_HOST = AGENT_LOCAL_HOST;

/** Whether `alias` names the `LOCAL_TERMINAL_HOST` (in any case). */
export function isLocalTerminalHost(alias: string): boolean {
  return alias.toLowerCase() === LOCAL_TERMINAL_HOST.toLowerCase();
}

/**
 * Agent local terminal (`/v2/ssh/agent-local`). When enabled, agents' TodeX
 * SSH tools list an `AGENT_LOCAL_HOST` host that runs commands on the machine
 * running the TodeX backend, with the same approvals and output filter as SSH
 * hosts. Takes effect from the next conversation start; turning it off applies
 * immediately. An SSH host whose alias equals `Local` (case-insensitively) is
 * then hidden from agents.
 */
export type AgentLocalTerminal = {
  enabled: boolean;
};

/** Values hidden from the agent per category; only counts above zero. */
export type AgentOutputRedactions = Partial<Record<AgentOutputFilterCategory, number>>;

/** Reads `ssh.exec.completed`'s `redactions`; undefined when nothing was hidden. */
export function parseAgentOutputRedactions(value: unknown): AgentOutputRedactions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const counts: AgentOutputRedactions = {};
  for (const category of AGENT_OUTPUT_FILTER_CATEGORIES) {
    const count = record[category];
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) counts[category] = Math.floor(count);
  }
  return Object.keys(counts).length ? counts : undefined;
}

/** Nonzero categories in canonical order, with the total. */
export function summarizeAgentOutputRedactions(redactions: AgentOutputRedactions | undefined): {
  total: number;
  items: Array<{ category: AgentOutputFilterCategory; count: number }>;
} {
  const items = AGENT_OUTPUT_FILTER_CATEGORIES
    .map(category => ({ category, count: redactions?.[category] ?? 0 }))
    .filter(item => item.count > 0);
  return { total: items.reduce((sum, item) => sum + item.count, 0), items };
}

export const SSH_SERVER_ALIVE_INTERVAL_RANGE = { min: 5, max: 600 } as const;
export const SSH_SERVER_ALIVE_COUNT_MAX_RANGE = { min: 1, max: 10 } as const;

export const SSH_FAILURE_KINDS = [
  'hostKeyUnverified',
  'hostKeyChanged',
  'authenticationFailed',
  'unreachable',
  'timedOut',
  'other',
] as const;

export type SshFailureKind = (typeof SSH_FAILURE_KINDS)[number];

export function isSshFailureKind(value: unknown): value is SshFailureKind {
  return typeof value === 'string' && (SSH_FAILURE_KINDS as readonly string[]).includes(value);
}

export type SshTestResult = {
  ok: boolean;
  durationMs: number;
  failure?: SshFailureKind;
  detail?: string;
};

export type SshKeyAlgorithm = 'ed25519' | 'rsa' | 'ecdsa';

export const SSH_KEY_ALGORITHMS: readonly SshKeyAlgorithm[] = ['ed25519', 'rsa', 'ecdsa'];

export type SshKey = {
  /** Base file name, e.g. `id_ed25519`. */
  name: string;
  /** Absent when only a `.pub` file exists. */
  privateKeyPath?: string;
  publicKeyPath?: string;
  /** `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, ... */
  algorithm: string;
  bits?: number;
  /** `SHA256:...` */
  fingerprint: string;
  comment?: string;
  /** Passphrase-protected; absent when unknown or there is no private key. */
  encrypted?: boolean;
  loadedInAgent: boolean;
  /** Full OpenSSH public key line (safe to copy). */
  publicKey?: string;
  /** Host aliases whose resolved identity files point at this key. */
  usedBy: string[];
};

export type SshKeysResponse = { sshDirectory: string; agentAvailable: boolean; keys: SshKey[] };

export type SshKeyImportInput = { name: string; privateKey: string; publicKey?: string; passphrase?: string };

export type SshKeyGenerateInput = { name: string; algorithm: SshKeyAlgorithm; comment?: string; passphrase?: string };

/** Same rule the backend enforces for files written to `~/.ssh/<name>`. */
const SSH_KEY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export function isValidSshKeyName(name: string): boolean {
  return SSH_KEY_NAME_PATTERN.test(name);
}

export type RemoteConnectionKind = 'sftp' | 'ftp';

export type RemoteConnection = {
  id: string;
  kind: RemoteConnectionKind;
  /** SFTP: the SSH host alias. */
  host?: string;
  /** FTP: the site id. */
  siteId?: string;
  label: string;
  homeDirectory: string;
  openedAt: number;
  lastUsedAt: number;
};

export type OpenRemoteConnectionInput =
  | { kind: 'sftp'; host: string; password?: string }
  | { kind: 'ftp'; siteId: string; password?: string };

export type RemoteEntryKind = 'file' | 'directory' | 'symlink';

export type RemoteEntry = {
  name: string;
  path: string;
  kind: RemoteEntryKind;
  sizeBytes?: number;
  modifiedAt?: number;
  permissions?: string;
};

export type RemoteEntriesResponse = { path: string; parent?: string; entries: RemoteEntry[] };

/** Same shape as `GET /v2/workspace/file`. */
export type RemoteFile = {
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  text?: string;
  dataUrl?: string;
};

/** Per-file transfer ceiling for remote upload and download. */
export const REMOTE_TRANSFER_MAX_BYTES = 100 * 1024 * 1024;
/** Largest raw body the backend accepts for one upload request. */
export const REMOTE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const REMOTE_AUTH_FAILED = 'REMOTE_AUTH_FAILED';
export const REMOTE_HOST_KEY_UNVERIFIED = 'REMOTE_HOST_KEY_UNVERIFIED';

function backendCodeOf(error: unknown): string | undefined {
  return error instanceof ConnectionError ? error.backendCode : undefined;
}

/** SFTP/FTP login failed; the caller may retry once with a password. */
export function isRemoteAuthFailure(error: unknown): boolean {
  return backendCodeOf(error) === REMOTE_AUTH_FAILED;
}

export function isRemoteHostKeyUnverified(error: unknown): boolean {
  return backendCodeOf(error) === REMOTE_HOST_KEY_UNVERIFIED;
}

/** Older backends answer the SSH routes with 404; treat that as "unsupported". */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ConnectionError && error.httpStatus === 404;
}

/** `user@hostName:port` as resolved by `ssh -G`, falling back to the alias. */
export function sshHostEndpoint(host: Pick<SshHost, 'alias' | 'resolved'>): string {
  const resolved = host.resolved;
  const name = resolved?.hostName || host.alias;
  const user = resolved?.user ? `${resolved.user}@` : '';
  const port = resolved?.port ? `:${resolved.port}` : '';
  return `${user}${name}${port}`;
}

/** Remote paths are always POSIX, whatever the client or backend OS. */
export function remoteJoinPath(directory: string, name: string): string {
  const base = directory.replace(/\/+$/, '');
  const leaf = name.replace(/^\/+/, '');
  return base ? `${base}/${leaf}` : `/${leaf}`;
}

export function remoteParentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

export function remoteBaseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** One agent `ssh_exec` call, rebuilt from `ssh.exec.*` conversation events. */
export type SshExecOutputChunk = { stream: 'stdout' | 'stderr'; data: string };
export type SshExecStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** A value the privacy filter hid from the agent (`ssh.exec.completed`'s
 * `redactedValues`); `category` may be one this client does not know. */
export type SshExecRedactedValue = {
  stream: 'stdout' | 'stderr';
  category: string;
  /** As in the agent's `[REDACTED:<label>]` placeholder. */
  label: string;
  text: string;
};

/** Reads `ssh.exec.completed`'s `redactedValues`, dropping malformed entries. */
export function parseSshExecRedactedValues(value: unknown): SshExecRedactedValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: SshExecRedactedValue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { stream, category, label, text } = entry as Record<string, unknown>;
    if ((stream !== 'stdout' && stream !== 'stderr') || typeof text !== 'string' || !text) continue;
    values.push({
      stream,
      category: typeof category === 'string' ? category : '',
      label: typeof label === 'string' ? label : '',
      text,
    });
  }
  return values.length ? values : undefined;
}

/** A piece of one output chunk: plain text, or a value hidden from the agent. */
export type SshExecOutputSegment = { text: string; redacted?: SshExecRedactedValue };

/**
 * Splits each chunk into plain and hidden segments: every occurrence of a
 * value of the chunk's stream, longer values first, without overlaps. Values
 * cut across chunks or beyond the recorded output stay plain.
 */
export function maskSshExecOutput(
  chunks: readonly SshExecOutputChunk[],
  values: readonly SshExecRedactedValue[] | undefined,
): SshExecOutputSegment[][] {
  const byLength = [...(values ?? [])].sort((a, b) => b.text.length - a.text.length);
  return chunks.map((chunk) => {
    const found: Array<{ start: number; end: number; value: SshExecRedactedValue }> = [];
    for (const value of byLength) {
      if (value.stream !== chunk.stream) continue;
      for (let at = chunk.data.indexOf(value.text); at >= 0; at = chunk.data.indexOf(value.text, at + 1)) {
        const end = at + value.text.length;
        if (found.some(other => at < other.end && other.start < end)) continue;
        found.push({ start: at, end, value });
      }
    }
    if (!found.length) return [{ text: chunk.data }];
    found.sort((a, b) => a.start - b.start);
    const segments: SshExecOutputSegment[] = [];
    let copied = 0;
    for (const { start, end, value } of found) {
      if (start > copied) segments.push({ text: chunk.data.slice(copied, start) });
      segments.push({ text: chunk.data.slice(start, end), redacted: value });
      copied = end;
    }
    if (copied < chunk.data.length) segments.push({ text: chunk.data.slice(copied) });
    return segments;
  });
}
export type SshExecRun = {
  /** The backend `execId`. */
  id: string;
  host: string;
  command: string;
  cwd?: string;
  status: SshExecStatus;
  exitCode?: number;
  failure?: SshFailureKind | 'cancelled';
  durationMs?: number;
  /** The agent's result was cut at 256 KiB per stream. */
  truncated?: boolean;
  /** The recorded output below stopped at 64 KiB per stream. */
  outputTruncated?: boolean;
  /** Values the privacy filter hid from the agent's copy of the output;
   * absent when nothing was hidden. The recorded output stays raw. */
  redactions?: AgentOutputRedactions;
  /** The hidden values themselves, for masking them in the recorded output
   * (`maskSshExecOutput`); absent on older backends and before completion. */
  redactedValues?: SshExecRedactedValue[];
  /** Output in arrival order; consecutive chunks of one stream are joined. */
  output: SshExecOutputChunk[];
  turnId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** The login this call asked for when ssh could not authenticate on its
   * own (`ssh.login.*`); calls that joined another call's request have none. */
  login?: SshExecLogin;
};

/** How an agent's login request ended (`ssh.login.resolved`). */
export type SshLoginOutcome = 'connected' | 'declined' | 'timedOut' | 'cancelled';

export type SshExecLogin = {
  requestId: string;
  status: 'pending' | SshLoginOutcome;
  /** When the backend stops waiting (RFC 3339). */
  expiresAt?: string;
  /** The login used a password the client had saved. */
  remembered?: boolean;
};

/** Body of `POST /v2/ssh/hosts/{alias}/login`; no password declines. */
export type SshLoginAnswerInput = { requestId: string; password?: string; saved?: boolean };

/** Reply to a login answer; `failed` leaves the request open for another try. */
export type SshLoginAnswer =
  | { status: 'connected' | 'declined' }
  | { status: 'failed'; failure?: SshFailureKind; detail?: string };

/** A login request still waiting for an answer at `now`. */
export function isSshLoginPending(login: SshExecLogin | undefined, now = Date.now()): boolean {
  if (!login || login.status !== 'pending') return false;
  const expires = login.expiresAt ? Date.parse(login.expiresAt) : NaN;
  return !Number.isFinite(expires) || expires > now;
}

/** Most recent calls kept per conversation runtime. */
export const SSH_EXEC_RUN_LIMIT = 50;

// ---------------------------------------------------------------------------
// Port forwarding (`/v2/ssh/forwards`) and the loopback IP pool
// (`/v2/ssh/ip-pool`). Both run on the machine running the backend.

/** `ssh -L` / `-R` / `-D`. */
export type SshForwardKind = 'local' | 'remote' | 'dynamic';

export const SSH_FORWARD_KINDS: readonly SshForwardKind[] = ['local', 'remote', 'dynamic'];

/** Bind addresses the backend accepts for `local` and `dynamic` forwards. */
export const SSH_LOOPBACK_BIND_ADDRESSES = ['127.0.0.1', '::1', 'localhost'] as const;

export const SSH_FORWARD_DEFAULT_BIND_ADDRESS = '127.0.0.1';

export type SshForwardInput = {
  /** Must exist in the host list. */
  alias: string;
  kind: SshForwardKind;
  /** local/dynamic: one of `SSH_LOOPBACK_BIND_ADDRESSES` (default 127.0.0.1); remote: optional. */
  bindAddress?: string;
  bindPort: number;
  /** Required for local/remote, absent for dynamic. */
  targetHost?: string;
  targetPort?: number;
  /** At most `SSH_FORWARD_LABEL_MAX` characters. */
  label?: string;
};

export type SshForwardStatus = 'stopped' | 'starting' | 'running' | 'failed';

export type SshForward = SshForwardInput & {
  id: string;
  status: SshForwardStatus;
  failure?: SshFailureKind;
  /** Short reason (stderr summary); never contains passwords. */
  error?: string;
  /** RFC3339. */
  startedAt?: string;
};

/** Forwards that may run at the same time. */
export const SSH_FORWARD_RUN_LIMIT = 32;
export const SSH_FORWARD_LABEL_MAX = 80;
export const SSH_TARGET_HOST_MAX = 253;
export const SSH_PORT_RANGE = { min: 1, max: 65535 } as const;

export type SshIpPortMode = 'auto' | 'manual';

export type SshIpPoolConfig = {
  enabled: boolean;
  /** Inside 127.0.0.0/8, prefix 16..30, not containing 127.0.0.1. */
  cidr: string;
  idleMinutes: number;
};

export type SshIpAssignmentInput = {
  /** Omitted: next free address in the pool. */
  ip?: string;
  alias: string;
  portMode: SshIpPortMode;
  /** Manual only: `8080` or `7000-7010` entries. */
  ports?: string[];
};

export type SshIpAssignmentUpdate = { portMode: SshIpPortMode; ports?: string[] };

export type SshIpAssignmentState = 'disabled' | 'idle' | 'connecting' | 'connected' | 'needsLogin' | 'failed';

export type SshIpBindError = { kind: 'addressUnavailable' | 'other'; message: string };

export type SshIpAssignment = {
  ip: string;
  alias: string;
  portMode: SshIpPortMode;
  /** Manual list as saved (`[]` in auto mode). */
  ports: string[];
  listeningPorts: number;
  /** Ports that could not be bound; at most 100 listed. */
  skippedPorts: number[];
  skippedPortCount: number;
  bindError?: SshIpBindError;
  state: SshIpAssignmentState;
  activeConnections: number;
  connectedAt?: string;
  lastUsedAt?: string;
  failure?: SshFailureKind;
  error?: string;
};

export type SshIpPool = SshIpPoolConfig & {
  supported: boolean;
  unsupportedReason?: string;
  autoPorts: string[];
  manualPortLimit: number;
  assignments: SshIpAssignment[];
};

export const SSH_IP_POOL_DEFAULT_CIDR = '127.77.0.0/24';
export const SSH_IP_POOL_IDLE_MINUTES_RANGE = { min: 1, max: 1440 } as const;
export const SSH_IP_POOL_DEFAULT_IDLE_MINUTES = 15;
/** Ports one manual assignment may listen on. */
export const SSH_IP_MANUAL_PORT_LIMIT = 4096;
/** Rough backend memory cost of one idle listener, for estimates only. */
export const SSH_IP_BYTES_PER_LISTENER = 3_700;

function parsePortNumber(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= SSH_PORT_RANGE.min && port <= SSH_PORT_RANGE.max ? port : undefined;
}

export type SshPortSpecResult = { ports: number[] } | { error: string };

/**
 * Expands `8080` / `7000-7010` entries into sorted unique ports, rejecting
 * malformed entries, reversed ranges and sets above `limit`.
 */
export function parseSshPortSpec(entries: readonly string[], limit = SSH_IP_MANUAL_PORT_LIMIT): SshPortSpecResult {
  const ports = new Set<number>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(entry);
    if (match) {
      const start = parsePortNumber(match[1]);
      const end = parsePortNumber(match[2]);
      if (start === undefined || end === undefined) return { error: `Invalid port range: ${entry}` };
      if (start > end) return { error: `Range start is above its end: ${entry}` };
      for (let port = start; port <= end; port += 1) {
        ports.add(port);
        if (ports.size > limit) return { error: `More than ${limit} ports` };
      }
      continue;
    }
    const port = parsePortNumber(entry);
    if (port === undefined) return { error: `Invalid port: ${entry}` };
    ports.add(port);
    if (ports.size > limit) return { error: `More than ${limit} ports` };
  }
  return { ports: [...ports].sort((a, b) => a - b) };
}

/** Number of distinct ports in a valid spec; 0 when it does not parse. */
export function countSshPorts(entries: readonly string[]): number {
  const result = parseSshPortSpec(entries, Number.MAX_SAFE_INTEGER);
  return 'ports' in result ? result.ports.length : 0;
}

/** Bytes the backend roughly needs to keep `listeners` idle listeners. */
export function estimateSshListenerBytes(listeners: number): number {
  return Math.max(0, listeners) * SSH_IP_BYTES_PER_LISTENER;
}

export function isLoopbackBindAddress(value: string | undefined): boolean {
  return (SSH_LOOPBACK_BIND_ADDRESSES as readonly string[]).includes((value ?? '').trim().toLowerCase());
}

/** `host:port`, bracketing IPv6 literals. */
export function formatSshHostPort(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

export const SSH_IP_POOL_PREFIX_RANGE = { min: 16, max: 30 } as const;

export type SshIpPoolCidrError = 'format' | 'outsideLoopback' | 'prefix' | 'hostBits' | 'containsLocalhost';

/**
 * Checks a pool range the way the backend does: an IPv4 CIDR inside
 * 127.0.0.0/8 with a prefix of 16..30, no host bits set, and not containing
 * 127.0.0.1. Returns `null` when valid.
 */
export function validateSshIpPoolCidr(value: string): SshIpPoolCidrError | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return 'format';
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return 'format';
  if (octets[0] !== 127 || prefix < 8) return 'outsideLoopback';
  if (prefix < SSH_IP_POOL_PREFIX_RANGE.min || prefix > SSH_IP_POOL_PREFIX_RANGE.max) return 'prefix';
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  if ((address & mask) >>> 0 !== address) return 'hostBits';
  const localhost = 0x7f000001;
  if (((localhost & mask) >>> 0) === address) return 'containsLocalhost';
  return null;
}
