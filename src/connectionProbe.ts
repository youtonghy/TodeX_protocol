import { buildHttpUrl, normalizeServerUrl } from './todex';
import { ConnectionError, type ConnectionFailureCode } from './connectionError';
import { deviceAuthHeaders, type DeviceIdentity } from './deviceAuth';
import type { ProviderDescriptor } from './v2';

export type ServerVersionInfo = {
  name: string;
  version: string;
  dataDir?: string;
  workspaceRoot?: string;
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

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw ConnectionError.timeout(`Request timeout after ${timeoutMs}ms for ${url}`);
    }
    throw ConnectionError.unreachable(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyHttp(response: Response, endpoint: string): ConnectionError {
  if (response.status === 401 || response.status === 403) {
    return ConnectionError.authenticationFailed(response.status);
  }
  if (response.status === 404 && endpoint.includes('/v2/')) {
    return ConnectionError.protocolMismatch(`${endpoint} returned ${response.status}`);
  }
  if (response.status >= 500) {
    return ConnectionError.serverError(response.status);
  }
  return ConnectionError.protocolError(response.status);
}

export async function probeBackendConnection(options: {
  serverUrl: string;
  authToken?: string;
  device?: DeviceIdentity | null;
  fetchImpl?: typeof fetch;
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

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const headers = new Headers({ Accept: 'application/json' });
  if (options.authToken) {
    headers.set('Authorization', `Bearer ${options.authToken}`);
  }
  // Device credentials sign each request: the signature binds the path.
  const device = options.device ?? null;
  const headersFor = (path: string): Headers => {
    const signed = new Headers(headers);
    if (device) {
      for (const [name, value] of Object.entries(deviceAuthHeaders(device, 'GET', path))) {
        signed.set(name, value);
      }
    }
    return signed;
  };

  try {
    const versionResponse = await fetchText(
      fetchImpl,
      buildHttpUrl(origin, '/v2/version'),
      { headers: headersFor('/v2/version') },
      timeoutMs,
    );
    if (!versionResponse.ok) {
      const error = classifyHttp(versionResponse, '/v2/version');
      return { ...empty, error, code: error.code };
    }
    const versionJson = await versionResponse.json() as Record<string, unknown>;
    const version: ServerVersionInfo = {
      name: typeof versionJson.name === 'string' ? versionJson.name : '',
      version: typeof versionJson.version === 'string' ? versionJson.version : '',
      dataDir: typeof versionJson.data_dir === 'string' ? versionJson.data_dir : undefined,
      workspaceRoot: typeof versionJson.workspace_root === 'string' ? versionJson.workspace_root : undefined,
    };
    if (version.name && version.name !== 'todex-agentd') {
      const error = ConnectionError.protocolMismatch(`unexpected server name ${version.name}`);
      return { ...empty, version, error, code: error.code };
    }

    const healthResponse = await fetchText(
      fetchImpl,
      buildHttpUrl(origin, '/health'),
      { headers: headersFor('/health') },
      timeoutMs,
    );
    if (!healthResponse.ok) {
      const error = classifyHttp(healthResponse, '/health');
      return { ...empty, version, error, code: error.code };
    }

    const providersResponse = await fetchText(
      fetchImpl,
      buildHttpUrl(origin, '/v2/providers'),
      { headers: headersFor('/v2/providers') },
      timeoutMs,
    );
    if (!providersResponse.ok) {
      const error = classifyHttp(providersResponse, '/v2/providers');
      return { ...empty, version, error, code: error.code };
    }
    const providersJson = await providersResponse.json() as { providers?: ProviderDescriptor[] };
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

export function nextReconnectDelayMs(attempt: number): number {
  const clamped = Math.max(0, Math.min(attempt, 8));
  return Math.min(2000 * (2 ** clamped), 30_000);
}
