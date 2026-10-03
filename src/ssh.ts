import { ConnectionError } from './connectionError';

/**
 * SSH hosts, keys and remote file connections served by `todex-agentd`
 * (`/v2/ssh/*`, `/v2/ftp/*`, `/v2/remote/*`). Every host and key belongs to the
 * machine running the backend, never to the client. Passwords and key
 * passphrases are sent per request and are never persisted by either side.
 */

export type SshHostSource = 'sshConfig' | 'managed';

export type SshHostOption = { key: string; value: string };

/** Editable definition of a TodeX-managed host (`$DATA_DIR/ssh/hosts.conf`). */
export type ManagedHost = {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  options?: SshHostOption[];
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

export type SshHostsResponse = { hosts: SshHost[]; ftpSites: FtpSite[] };

export type SshHostImportResult = { hosts: ManagedHost[]; errors: string[] };

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

export type RemoteDownload = { name: string; sizeBytes: number; data: string };

/** Per-file transfer ceiling for remote upload and download. */
export const REMOTE_TRANSFER_MAX_BYTES = 100 * 1024 * 1024;

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
