/**
 * Agent desktop tools (`todex_desktop` MCP server).
 *
 * Agents run next to the daemon, which may be remote; the browser they drive
 * belongs to a desktop client. A desktop registers as an *executor* on a
 * dedicated `/v2/ws` connection; the daemon forwards each tool call as
 * `executor.invoke` and waits for `executor.result`. When the daemon is not
 * on the desktop's machine, `localhost` pages are reached through `tunnel.*`
 * streams on the same connection.
 */

/** MCP server name agents see; tools appear as `mcp__todex_desktop__browser_open`. */
export const AGENT_DESKTOP_SERVER = 'todex_desktop';

/** `browser`: agent browser tabs. `screen`: Computer Use (macOS 14+, both switches on). */
export type ExecutorCapability = 'browser' | 'screen';

export const AGENT_BROWSER_TOOLS = [
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_act',
  'browser_close',
] as const;
export type AgentBrowserTool = typeof AGENT_BROWSER_TOOLS[number];

export const AGENT_COMPUTER_TOOLS = ['computer_observe', 'computer_act', 'computer_done'] as const;
export type AgentComputerTool = typeof AGENT_COMPUTER_TOOLS[number];

export type ExecutorInfo = {
  executorId: number;
  deviceId: string;
  deviceName: string;
  platform: string;
  capabilities: ExecutorCapability[];
};

/** `GET|PUT /v2/agent-desktop`. A 404 means the daemon predates desktop tools. */
export type AgentDesktopSettings = {
  /** Agents get the `todex_desktop` MCP server. Off by default. */
  enabled: boolean;
  /** Agents also get the `computer_*` tools (needs `enabled`). Off by default. */
  computerEnabled: boolean;
  executors: ExecutorInfo[];
};

// ---- Client → daemon frames ------------------------------------------------

/** `{ id, type: 'executor.register', payload }` → `server.result` {@link ExecutorRegistered}. */
export type ExecutorRegisterPayload = {
  capabilities: ExecutorCapability[];
  /** `process.platform` of the desktop. */
  platform: string;
};

export type ExecutorRegistered = { executorId: number; deviceId: string };

/** `{ type: 'executor.result', payload }`; no response. */
export type ExecutorResultPayload =
  | { invokeId: string; ok: true; result: AgentBrowserResult }
  | { invokeId: string; ok: false; error: ExecutorFailure };

export type ExecutorFailure = {
  code: ExecutorErrorCode | string;
  message: string;
  /** `APP_CONFIRM`: `{ bundleId, name }` of the app awaiting approval. */
  detail?: Record<string, unknown>;
};

/**
 * - `NAVIGATION_BLOCKED`: top-level navigation outside loopback.
 * - `NO_TAB`: the conversation has no open tab (call `browser_open`).
 * - `REF_NOT_FOUND`: the `ref` is not in the latest snapshot.
 * - `TAB_LIMIT`: too many agent tabs on this desktop.
 * - `SENSITIVE_ACTION`: the action needs the user's confirmation; the daemon
 *   asks and re-invokes with `confirmed: true`.
 * - `TUNNEL_FAILED`: the daemon's port could not be forwarded.
 * - `USER_ACTIVE`: the user is using the pointer; retry shortly.
 * - `TARGET_BLOCKED`: the target app or window may never be controlled.
 * - `APP_CONFIRM`: first action in this app; the daemon asks and re-invokes
 *   with the app in `allowedApps`.
 * - `PERMISSION_REQUIRED`: Screen Recording or Accessibility is not granted.
 * - `SCREEN_BUSY`: another conversation controls this screen (daemon).
 */
export type ExecutorErrorCode =
  | 'NAVIGATION_BLOCKED'
  | 'NO_TAB'
  | 'REF_NOT_FOUND'
  | 'TAB_LIMIT'
  | 'SENSITIVE_ACTION'
  | 'TUNNEL_FAILED'
  | 'USER_ACTIVE'
  | 'TARGET_BLOCKED'
  | 'APP_CONFIRM'
  | 'PERMISSION_REQUIRED'
  | 'SCREEN_BUSY'
  | 'INVALID_ARGUMENT'
  | 'EXECUTOR_FAILED';

// ---- Daemon → client frames ------------------------------------------------

/** `{ type: 'executor.invoke', payload }`. */
export type ExecutorInvokePayload = {
  invokeId: string;
  conversationId: string;
  /** Selects the browser partition; `id` is absent for ad-hoc workspaces. */
  workspace: { id?: string; path: string };
  tool: AgentBrowserTool | AgentComputerTool;
  args: AgentBrowserArgs | ComputerArgs;
  timeoutMs: number;
};

/** `{ type: 'executor.cancel', payload: { invokeId } }`: nobody waits for the call any more. */
export type ExecutorCancelPayload = { invokeId: string };

/** `{ type: 'executor.release', payload: { conversationId } }`: access revoked or conversation gone; close its tab. */
export type ExecutorReleasePayload = {
  conversationId: string;
  /** Only that capability's state (tab, or screen control); absent: all. */
  capability?: ExecutorCapability;
};

// ---- Tool arguments and results -------------------------------------------

export type BrowserOpenArgs = { url: string };
export type BrowserNavigateArgs = { url?: string; action?: 'back' | 'forward' | 'reload' };
export type BrowserSnapshotArgs = { screenshot?: boolean };
export type BrowserActAction = 'click' | 'type' | 'press' | 'scroll' | 'select' | 'hover' | 'wait';
export type BrowserActArgs = {
  action: BrowserActAction;
  /** Element reference from the latest snapshot (`e12`). */
  ref?: string;
  /** `type`: text to enter; `select`: option label or value. */
  text?: string;
  /** `press`: key such as `Enter`, `Tab`, `ArrowDown`. */
  key?: string;
  /** `scroll`: pixels, positive is down. */
  deltaY?: number;
  /** `wait`: milliseconds, at most 10000. */
  ms?: number;
  /** Set by the daemon after the user confirmed a `SENSITIVE_ACTION`. */
  confirmed?: boolean;
};
export type BrowserCloseArgs = Record<string, never>;

export type AgentBrowserArgs =
  | BrowserOpenArgs
  | BrowserNavigateArgs
  | BrowserSnapshotArgs
  | BrowserActArgs
  | BrowserCloseArgs;

export type BrowserScreenshot = {
  mimeType: 'image/jpeg';
  /** Base64, no data-URL prefix. */
  data: string;
  width: number;
  height: number;
};

export type BrowserPageResult = {
  url: string;
  title: string;
  /** The page is a daemon `localhost` port forwarded to this local port. */
  tunnel?: { remotePort: number; localPort: number };
};

export type BrowserSnapshotResult = BrowserPageResult & {
  /** Indented accessibility tree; interactive nodes carry `[ref=eN]`. */
  tree: string;
  truncated: boolean;
  screenshot?: BrowserScreenshot;
};

export type BrowserActResult = BrowserPageResult & { detail?: string };

export type AgentBrowserResult = BrowserPageResult | BrowserSnapshotResult | BrowserActResult | Record<string, never>;

// ---- Computer Use ------------------------------------------------------------

export type ComputerObserveArgs = {
  /** Bundle id or name; default: the frontmost app. */
  app?: string;
  /** Window id from `windows`; default: the app's front window. */
  window?: number;
  /** Capture this display (index in `displays`) instead of the window. */
  display?: number;
  screenshot?: boolean;
};

export type ComputerActAction =
  | 'click' | 'double_click' | 'right_click' | 'hover' | 'drag' | 'scroll'
  | 'type' | 'key' | 'wait' | 'open_app' | 'focus_window';

export type ComputerActArgs = {
  action: ComputerActAction;
  /** Element from the latest `computer_observe` (`e12`): acts in the background. */
  ref?: string;
  /** Screenshot pixel coordinates of the latest observation: moves the pointer. */
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  /** `type`: text to insert. */
  text?: string;
  /** `key`: chord such as `cmd+c`, `enter`, `shift+tab`. */
  keys?: string;
  /** `open_app` / `focus_window`: bundle id or name. */
  app?: string;
  window?: number;
  deltaX?: number;
  deltaY?: number;
  ms?: number;
  /** Set by the daemon: bundle ids approved for this conversation. */
  allowedApps?: string[];
  /** Set by the daemon after the user confirmed a `SENSITIVE_ACTION`. */
  confirmed?: boolean;
};

export type ComputerDoneArgs = Record<string, never>;
export type ComputerArgs = ComputerObserveArgs | ComputerActArgs | ComputerDoneArgs;

export type ComputerApp = { name: string; bundleId: string; pid: number };
export type ComputerWindow = { id: number; app: string; bundleId: string; title: string };
export type ComputerDisplay = { index: number; x: number; y: number; width: number; height: number; scale: number };

/** Screenshot plus the mapping from its pixels to global screen points. */
export type ComputerScreenshot = BrowserScreenshot & {
  /** Global point of pixel (0, 0). */
  originX: number;
  originY: number;
  /** Screen points per screenshot pixel. */
  pointsPerPixel: number;
};

export type ComputerObserveResult = {
  app: ComputerApp;
  window?: ComputerWindow & { x: number; y: number; width: number; height: number };
  windows: ComputerWindow[];
  displays: ComputerDisplay[];
  /** Indented accessibility tree; actionable nodes carry `[ref=eN]`. */
  tree: string;
  truncated: boolean;
  screenshot?: ComputerScreenshot;
};

export type ComputerActResult = {
  app: ComputerApp;
  /** `background`: delivered to the element; `pointer`: moved the pointer. */
  path: 'background' | 'pointer' | 'none';
  detail?: string;
};

// ---- Tunnel frames (both directions, no ids) ------------------------------

/** Client → daemon: a local TCP connection was accepted for `port` on the daemon host. */
export type TunnelOpenPayload = { streamId: string; conversationId: string; port: number };
/** Daemon → client: the daemon connected to its loopback port. */
export type TunnelOpenedPayload = { streamId: string };
/** Base64 bytes; each side may have at most {@link TUNNEL_WINDOW_BYTES} unacknowledged. */
export type TunnelDataPayload = { streamId: string; data: string };
export type TunnelAckPayload = { streamId: string; bytes: number };
/** Either side; `error` set when the stream failed rather than ended. */
export type TunnelClosePayload = { streamId: string; error?: string };

/** Raw bytes per `tunnel.data` frame. */
export const TUNNEL_CHUNK_BYTES = 32 * 1024;
/** Unacknowledged raw bytes per stream and direction. */
export const TUNNEL_WINDOW_BYTES = 256 * 1024;
/** Concurrent streams per executor connection. */
export const TUNNEL_MAX_STREAMS = 64;

// ---- Conversation events and permissions ----------------------------------

/** `desktop.browser.action`: one tool call, journaled without image data. */
export type DesktopBrowserActionEvent = {
  actionId: string;
  tool: AgentBrowserTool;
  ok: boolean;
  url?: string;
  title?: string;
  /** Short human summary, e.g. `click "Sign in"`. */
  summary: string;
  error?: ExecutorFailure;
  /** `GET /v2/conversations/{id}/agent-shots/{shotId}`. */
  shotId?: string;
  deviceId: string;
  deviceName: string;
};

/** `desktop.browser.grant`: the conversation was bound to, or released from, an executor. */
export type DesktopBrowserGrantEvent = {
  status: 'granted' | 'revoked';
  deviceId?: string;
  deviceName?: string;
  reason?: string;
};

/** `permission.requested.kind` of the per-conversation first grant. */
export const DESKTOP_BROWSER_GRANT_KIND = 'desktop_browser';
/** `permission.requested.kind` of a single sensitive action. */
export const DESKTOP_BROWSER_ACTION_KIND = 'desktop_browser_action';
/** First Computer Use in a conversation; executor devices only. */
export const DESKTOP_COMPUTER_GRANT_KIND = 'desktop_computer';
/** First action in an app during a conversation; any device. */
export const DESKTOP_COMPUTER_APP_KIND = 'desktop_computer_app';
/** A sensitive Computer Use action (password field); any device. */
export const DESKTOP_COMPUTER_ACTION_KIND = 'desktop_computer_action';

/** `desktop.computer.session`: a conversation took or released the screen. */
export type DesktopComputerSessionEvent = {
  status: 'started' | 'ended';
  deviceId?: string;
  deviceName?: string;
  /** `done`, `idle`, `user`, `revoked`, `disconnected`. */
  reason?: string;
};

/** `desktop.computer.action`: one Computer Use call, journaled without image data. */
export type DesktopComputerActionEvent = {
  actionId: string;
  tool: AgentComputerTool;
  ok: boolean;
  summary: string;
  app?: string;
  windowTitle?: string;
  path?: ComputerActResult['path'];
  error?: ExecutorFailure;
  shotId?: string;
  deviceId: string;
  deviceName: string;
};

/** `details` of a {@link DESKTOP_BROWSER_GRANT_KIND} permission. */
export type DesktopBrowserGrantDetails = {
  executors: Array<Pick<ExecutorInfo, 'deviceId' | 'deviceName' | 'platform'>>;
};

/** `GET /v2/conversations/{id}/agent-shots/{shotId}`. */
export type AgentShot = { shotId: string; mimeType: string; dataUrl: string };

export function isAgentComputerTool(value: unknown): value is AgentComputerTool {
  return typeof value === 'string' && (AGENT_COMPUTER_TOOLS as readonly string[]).includes(value);
}

export function isAgentBrowserTool(value: unknown): value is AgentBrowserTool {
  return typeof value === 'string' && (AGENT_BROWSER_TOOLS as readonly string[]).includes(value);
}
