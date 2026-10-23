/**
 * Backends a client reaches over a local IPC channel (a Unix socket or a
 * Windows named pipe) instead of TCP. Their server URL is
 * `todex-ipc://<instance>`; the host platform maps the instance to a socket
 * and serves requests to that URL (Electron: a privileged protocol handler for
 * `fetch`, a registered WebSocket implementation for sockets). Kept
 * dependency-free so `todex.ts` and `secureTransport.ts` can import it.
 */

export const IPC_SERVER_PROTOCOL = 'todex-ipc:';

const IPC_INSTANCE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The instance id of a `todex-ipc://<instance>` URL, or null for any other
 * value (including IPC URLs with credentials, a port, or an invalid id). */
export function ipcServerInstance(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^todex-ipc:\/\/([^/?#]*)(?:[/?#]|$)/i);
  if (!match) return null;
  const instance = match[1].toLowerCase();
  return IPC_INSTANCE.test(instance) ? instance : null;
}

export function isIpcServerUrl(value: string | null | undefined): boolean {
  return ipcServerInstance(value) !== null;
}

export function ipcServerUrl(instance: string): string {
  const normalized = instance.trim().toLowerCase();
  if (!IPC_INSTANCE.test(normalized)) throw new TypeError(`invalid IPC backend instance ${instance}`);
  return `todex-ipc://${normalized}`;
}

type WebSocketConstructor = typeof WebSocket;

let ipcWebSocket: WebSocketConstructor | null = null;
let ipcFetch: typeof fetch | null = null;

/** Registers the WebSocket implementation that serves `todex-ipc://` URLs
 * (pass null to remove it). Platforms without IPC never register one. */
export function setIpcWebSocketImpl(impl: WebSocketConstructor | null): void {
  ipcWebSocket = impl;
}

export function ipcWebSocketImpl(): WebSocketConstructor {
  if (!ipcWebSocket) throw new Error('this client cannot open local IPC backends');
  return ipcWebSocket;
}

/** Registers the `fetch` that serves `todex-ipc://` URLs where the global
 * one cannot (a host process talking to the socket directly). Clients whose
 * global `fetch` already handles the scheme register nothing. */
export function setIpcFetchImpl(impl: typeof fetch | null): void {
  ipcFetch = impl;
}

/** The registered IPC `fetch` for an IPC server URL, else null. */
export function ipcFetchImplFor(serverUrl: string): typeof fetch | null {
  return ipcFetch && isIpcServerUrl(serverUrl) ? ipcFetch : null;
}
