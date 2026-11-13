/**
 * The client side of the backend's `POST /v2/browser/proxy` (API.md, 浏览器代理):
 * wrapping a preview page's loopback request, unwrapping the forwarded
 * response head and classifying failures. Moved from the desktop's
 * `src/main/previewProxy.ts` so the mobile client forwards the same way; the
 * transport (`SecureTransport.fetchStream`) and the user-facing texts stay
 * with each client.
 */
import { decodeBase64UrlBytes, encodeBase64Url } from './transportCrypto';

export const BROWSER_PROXY_PATH = '/v2/browser/proxy';

/**
 * Forwarded requests waiting for their response head at once. The backend
 * lets one device hold 8 sealed requests until then and refuses the rest as
 * busy (`TRANSPORT_BUSY`); a dev server's page load fires dozens of module
 * requests, and the app's own calls share the same budget.
 */
export const BROWSER_PROXY_MAX_IN_FLIGHT = 6;

/** Largest request body the backend forwards (decoded). */
export const BROWSER_PROXY_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Statuses whose responses never have a body. */
export const BROWSER_PROXY_NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** Request headers that describe this hop, or that the backend sets itself. */
const HOP_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect']);
/** Response headers that describe the backend's hop, not the page's response. */
const HOP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

export type BrowserProxyHeader = [name: string, value: string];

export type BrowserProxyRequestOptions = {
  /**
   * Drop the page's `cookie` header. The desktop does, because it adds the
   * cookies of its own jar; a client whose web view sends cookies itself
   * keeps them (minus its own, which it strips first).
   */
  dropCookies?: boolean;
};

/**
 * The page's request headers the backend should send on: hop-by-hop
 * headers, `host`, `content-length`, `proxy-*` and every `x-todex-*` header
 * go, everything else (cookies unless `dropCookies`, `origin`, `range`, …)
 * stays in order.
 */
export function browserProxyRequestHeaders(headers: Iterable<readonly [string, string]>, options: BrowserProxyRequestOptions = {}): BrowserProxyHeader[] {
  const kept: BrowserProxyHeader[] = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (HOP_REQUEST_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('x-todex-')) continue;
    if (options.dropCookies && name === 'cookie') continue;
    kept.push([name, value]);
  }
  return kept;
}

export type BrowserProxyRequest = {
  method: string;
  /** The loopback URL as the backend should fetch it. */
  url: string;
  headers: BrowserProxyHeader[];
  body?: Uint8Array | null;
};

/** The JSON body of `POST /v2/browser/proxy`; an empty body is left out. */
export function browserProxyRequestBody(request: BrowserProxyRequest): string {
  const { method, url, headers, body } = request;
  return JSON.stringify({ method, url, headers, ...(body?.length ? { body: encodeBase64(body) } : {}) });
}

/** The sealed request for `transport.fetchStream`. */
export function browserProxyTransportRequest(request: BrowserProxyRequest, signal?: AbortSignal): {
  method: 'POST';
  path: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
} {
  return {
    method: 'POST',
    path: BROWSER_PROXY_PATH,
    headers: { 'content-type': 'application/json' },
    body: browserProxyRequestBody(request),
    ...(signal ? { signal } : {}),
  };
}

export type BrowserProxyResponseHead = {
  /** The page's status (`x-todex-proxy-status`). */
  status: number;
  /** The page's headers in order, repeated ones (`set-cookie`) as separate pairs. */
  headers: BrowserProxyHeader[];
};

/**
 * The forwarded response's head out of a `200` from the proxy route. Null
 * when the wrapper headers are missing or malformed (not a proxy answer).
 */
export function parseBrowserProxyResponseHead(headers: Readonly<Record<string, string>>): BrowserProxyResponseHead | null {
  const status = Number(lookup(headers, 'x-todex-proxy-status'));
  if (!Number.isInteger(status) || status < 100 || status > 999) return null;
  const encoded = lookup(headers, 'x-todex-proxy-headers') ?? '';
  let pairs: unknown;
  try {
    pairs = encoded ? JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(encoded))) : [];
  } catch {
    return null;
  }
  if (!Array.isArray(pairs)) return null;
  const parsed: BrowserProxyHeader[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return null;
    if (HOP_RESPONSE_HEADERS.has(pair[0].toLowerCase())) continue;
    parsed.push([pair[0], pair[1]]);
  }
  return { status, headers: parsed };
}

/** Whether the page's response to `method` with `status` carries a body. */
export function browserProxyHasBody(method: string, status: number): boolean {
  return method.toUpperCase() !== 'HEAD' && status >= 200 && !BROWSER_PROXY_NULL_BODY_STATUSES.has(status);
}

export type BrowserProxyFailure =
  /** 404: the backend predates `/v2/browser/proxy`. */
  | { kind: 'backend-outdated' }
  /** `BROWSER_TARGET_UNREACHABLE`: nothing answered on `target` on the backend host. */
  | { kind: 'target-unreachable'; target: string }
  /** Anything else; `reason` is the backend's message or the start of its body. */
  | { kind: 'forward-failed'; target: string; reason: string };

/**
 * Classifies a non-200 answer of the proxy route (`target` is the page's
 * `host:port`), as the desktop's error pages do.
 */
export function browserProxyFailure(status: number, bodyText: string, target: string): BrowserProxyFailure {
  if (status === 404) return { kind: 'backend-outdated' };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') {
      const code = 'code' in parsed ? parsed.code : undefined;
      const message = 'message' in parsed ? parsed.message : undefined;
      if (code === 'BROWSER_TARGET_UNREACHABLE') return { kind: 'target-unreachable', target };
      if (typeof message === 'string' && message) return { kind: 'forward-failed', target, reason: message };
    }
  } catch {
    // Not a backend error body.
  }
  return { kind: 'forward-failed', target, reason: bodyText.slice(0, 200) || `HTTP ${status}` };
}

/** Standard base64 with padding, as the proxy's `body` field takes it. */
export function encodeBase64(bytes: Uint8Array): string {
  const url = encodeBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
}

function lookup(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  if (name in headers) return headers[name];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
