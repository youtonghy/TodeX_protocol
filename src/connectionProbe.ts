import { normalizeServerUrl } from './todex';
import { jitteredBackoffMs } from './backoff';
import { ConnectionError, type ConnectionFailureCode } from './connectionError';
import type { SecureResponse, SecureTransport } from './secureTransport';
import type { ProviderDescriptor } from './v2';

export type ServerVersionInfo = {
  name: string;
  version: string;
  dataDir?: string;
  workspaceRoot?: string;
  /** `1` when the backend serves end-to-end encrypted history (§5.4). */
  historyEncryption?: number;
};

export type BackendProbeResult = {
  ok: boolean;
  origin: string;
  version: ServerVersionInfo | null;
  providers: ProviderDescriptor[];
  error: ConnectionError | null;
  code: ConnectionFailureCode | '';
};

const PROBE_TIMEOUT_MS = 4000;

export function inspectServerUrl(raw: string): { origin: string; error: ConnectionError | null } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { origin: normalizeServerUrl(trimmed), error: null };
  }
  if (/(^|[^\w])\/v1(\/|$)/i.test(trimmed) || /\/v1\/ws/i.test(trimmed)) {
    return {
      origin: normalizeServerUrl(trimmed),
      error: ConnectionError.protocolMismatch(trimmed),
    };
  }
  try {
    const origin = normalizeServerUrl(trimmed);
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { origin, error: ConnectionError.invalidServerUrl(`unsupported scheme ${parsed.protocol}`) };
    }
    if (!parsed.hostname) {
      return { origin, error: ConnectionError.invalidServerUrl('missing hostname') };
    }
    return { origin, error: null };
  } catch (error) {
    return {
      origin: trimmed,
      error: ConnectionError.invalidServerUrl(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function tokenMatchesOrigin(tokenOrigin: string, serverUrl: string): boolean {
  if (!tokenOrigin.trim()) {
    return true;
  }
  return normalizeServerUrl(tokenOrigin) === normalizeServerUrl(serverUrl);
}

/** Whether a stored credential (token or device secret) was issued for this
 * server origin. Empty stored origins are accepted for legacy imports. */
export function credentialMatchesOrigin(credentialOrigin: string, serverUrl: string): boolean {
  return tokenMatchesOrigin(credentialOrigin, serverUrl);
}

async function probeGet(transport: SecureTransport, path: string, timeoutMs: number): Promise<SecureResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport.fetch({
      method: 'GET',
      path,
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw ConnectionError.timeout(`Request timeout after ${timeoutMs}ms for ${path}`);
    }
    throw ConnectionError.unreachable(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyHttp(status: number, endpoint: string): ConnectionError {
  if (status === 401 || status === 403) {
    return ConnectionError.authenticationFailed(status);
  }
  if (status === 404 && endpoint.includes('/v2/')) {
    return ConnectionError.protocolMismatch(`${endpoint} returned ${status}`);
  }
  if (status >= 500) {
    return ConnectionError.serverError(status);
  }
  return ConnectionError.protocolError(status);
}

const isOk = (response: SecureResponse) => response.status >= 200 && response.status < 300;
const json = (response: SecureResponse) => JSON.parse(new TextDecoder().decode(response.body)) as unknown;

/**
 * Reads `/v2/version`, `/health` and `/v2/providers` through `transport`
 * (the profile's `SecureTransport`: signed, and tunnelled when a key is
 * pinned), so a probe never bypasses the transport rules.
 */
export async function probeBackendConnection(options: {
  serverUrl: string;
  transport: SecureTransport;
  timeoutMs?: number;
}): Promise<BackendProbeResult> {
  const inspected = inspectServerUrl(options.serverUrl);
  const origin = inspected.origin;
  const empty: BackendProbeResult = {
    ok: false,
    origin,
    version: null,
    providers: [],
    error: inspected.error,
    code: inspected.error?.code ?? '',
  };
  if (inspected.error) {
    return empty;
  }

  const { transport } = options;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  try {
    const versionResponse = await probeGet(transport, '/v2/version', timeoutMs);
    if (!isOk(versionResponse)) {
      const error = classifyHttp(versionResponse.status, '/v2/version');
      return { ...empty, error, code: error.code };
    }
    const versionJson = json(versionResponse) as Record<string, unknown>;
    const version: ServerVersionInfo = {
      name: typeof versionJson.name === 'string' ? versionJson.name : '',
      version: typeof versionJson.version === 'string' ? versionJson.version : '',
      dataDir: typeof versionJson.data_dir === 'string' ? versionJson.data_dir : undefined,
      workspaceRoot: typeof versionJson.workspace_root === 'string' ? versionJson.workspace_root : undefined,
      historyEncryption: typeof versionJson.historyEncryption === 'number' ? versionJson.historyEncryption : undefined,
    };
    if (version.name && version.name !== 'todex-agentd') {
      const error = ConnectionError.protocolMismatch(`unexpected server name ${version.name}`);
      return { ...empty, version, error, code: error.code };
    }

    const healthResponse = await probeGet(transport, '/health', timeoutMs);
    if (!isOk(healthResponse)) {
      const error = classifyHttp(healthResponse.status, '/health');
      return { ...empty, version, error, code: error.code };
    }

    const providersResponse = await probeGet(transport, '/v2/providers', timeoutMs);
    if (!isOk(providersResponse)) {
      const error = classifyHttp(providersResponse.status, '/v2/providers');
      return { ...empty, version, error, code: error.code };
    }
    const providersJson = json(providersResponse) as { providers?: ProviderDescriptor[] };
    const providers = Array.isArray(providersJson.providers) ? providersJson.providers : [];

    return {
      ok: true,
      origin,
      version,
      providers,
      error: null,
      code: '',
    };
  } catch (error) {
    const connectionError = error instanceof ConnectionError
      ? error
      : ConnectionError.unreachable(error instanceof Error ? error.message : String(error));
    return { ...empty, error: connectionError, code: connectionError.code };
  }
}

/** Delay before reconnect attempt `attempt` (0-based): 2 s doubling up to
 * 30 s, with equal jitter so clients that dropped together (a daemon
 * restart, a network blip) do not reconnect in lockstep. */
export function nextReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return jitteredBackoffMs(attempt, { baseMs: 2000, capMs: 30_000, random });
}
