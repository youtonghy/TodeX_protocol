/**
 * Agent desktop tools (`todex_desktop` MCP server).
 *
 * Both run in the daemon, on its own host; clients only watch (live frames,
 * screenshots, the action journal) and answer prompts.
 *
 * - The agent browser (`browser_*`) is a headed Chrome for Testing the daemon
 *   pins and downloads; `localhost` is the daemon's host. Any paired device
 *   grants a conversation. Live frames stream over `/v2/ws`
 *   (`agentBrowser.watch` → {@link AgentBrowserFrame}).
 * - Computer Use (`computer_*`) controls the host itself; the person at the
 *   host grants each conversation there.
 * - The agent camera (`camera_*`) records a camera on the host that the user
 *   allowed in settings. Any paired device approves each use on a card with a
 *   live preview ({@link DESKTOP_CAMERA_KIND}), choosing the camera and how
 *   frames are captured. Frames are JPEG files the agent reads, never images
 *   sent to clients beyond previews.
 *
 * Desktops used to run the browser as *executors*; daemons still answer
 * their `executor.register` harmlessly.
 */

/** MCP server name agents see; tools appear as `mcp__todex_desktop__browser_open`. */
export const AGENT_DESKTOP_SERVER = 'todex_desktop';


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

export const AGENT_CAMERA_TOOLS = ['camera_list', 'camera_start', 'camera_stop'] as const;
export type AgentCameraTool = typeof AGENT_CAMERA_TOOLS[number];


/** Whether the daemon's host can run Computer Use. */
export type ComputerHostStatus = {
  /** The host's OS and session can run it at all. */
  supported: boolean;
  /** Supported, permitted, and someone at the host can confirm grants. */
  available: boolean;
  /** Why it is not available. */
  reason?: string;
  /** The computer agents would control. */
  host: string;
  /** `macos`, `windows`, `linux`, ... */
  platform: string;
  /** OS permissions granted to the TodeX backend on the host. */
  permissions: { screen: boolean; accessibility: boolean };
  /**
   * The permission the person at the host is being guided to grant right
   * now (macOS: a panel beside System Settings offers the backend to drag
   * into the list). Poll the settings while it is set.
   */
  permissionRequest?: AgentComputerPermission;
};

/**
 * Computer Use engine (`PUT /v2/agent-desktop { computerEngine }`):
 * `native` is the built-in one; `agentDesktop` reads trees and performs ref
 * actions through vercel-labs/agent-desktop, which the daemon downloads, and
 * adds the `set_value`, `select`, `toggle`, `expand`, `collapse` and
 * `scroll_to` actions. Policy, screenshots and typing stay built in.
 */
export type AgentComputerEngine = 'native' | 'agentDesktop';

/** The daemon's pinned agent-desktop release. */
export type AgentDesktopEngineStatus = {
  version: string;
  installed: boolean;
  downloading: boolean;
  /** 0..1 while downloading. */
  progress?: number;
  error?: string;
  /** `TODEX_AGENT_DESKTOP_PATH` points at another build. */
  overridden: boolean;
  /** Installed and ready. */
  available: boolean;
  /** Why it is not available. */
  reason?: string;
};

/** One OS permission of {@link AgentComputerStatus.permissions}. */
export type AgentComputerPermission = 'screen' | 'accessibility';

/** The daemon's pinned Chromium (Chrome for Testing). */
export type AgentBrowserInstall = {
  version: string;
  installed: boolean;
  downloading: boolean;
  /** 0..1 while downloading. */
  progress?: number;
  error?: string;
  /** `TODEX_AGENT_BROWSER_PATH` points at another Chromium. */
  overridden: boolean;
};

/**
 * The engine the agent browser runs on. `chromium` is the pinned Chrome for Testing (headed, or
 * headless without a display) with a profile per workspace. `kitesurf` is experimental:
 * Cloudflare's Kitesurf on a local `workerd`, headless, one fresh browser context per tab, no
 * profiles; rendering and scripting are incomplete and unbundled dev-server pages may not load.
 */
export type AgentBrowserEngine = 'chromium' | 'kitesurf';

/** The daemon's pinned Kitesurf engine and its `workerd`. */
export type AgentBrowserKitesurfStatus = AgentBrowserInstall & {
  /** This host's OS and architecture can run it (not Windows yet). */
  supported: boolean;
  /** Supported on this host and installed. */
  available: boolean;
  /** Why it is not available (unsupported OS, not installed yet). */
  reason?: string;
};

/** Whether the daemon's host can run the agent browser. */
export type AgentBrowserStatus = {
  /** The chosen {@link engine} can run. */
  available: boolean;
  reason?: string;
  /** The computer the browser runs on (its `localhost`). */
  host: string;
  chromium: AgentBrowserInstall;
  /** The chosen engine; absent from daemons with only Chromium. */
  engine?: AgentBrowserEngine;
  /** Optional engines' state (with {@link engine}). */
  engines?: { kitesurf: AgentBrowserKitesurfStatus };
  /** Whether hosts beyond {@link host} are asked about; absent from older daemons. */
  hostApproval?: AgentBrowserHostApproval;
};

/**
 * `ask`: each host beyond the daemon's computer once (allow once, always,
 * deny). `auto`: every host, once the conversation may use the browser.
 * Metadata addresses and the daemon's port stay refused either way.
 */
export type AgentBrowserHostApproval = 'ask' | 'auto';

/** `GET|PUT /v2/agent-desktop`. A 404 means the daemon predates desktop tools. */
export type AgentDesktopSettings = {
  /** Agents get the `todex_desktop` MCP server. Off by default. */
  enabled: boolean;
  /** Agents also get the `computer_*` tools (needs `enabled`). Off by default. */
  computerEnabled: boolean;
  /** Absent from daemons where Computer Use still ran on desktops. */
  computer?: ComputerHostStatus;
  /** Which engine Computer Use runs on. Absent from daemons with only the built-in one. */
  computerEngine?: AgentComputerEngine;
  /** Optional engines' install state (with {@link computerEngine}). */
  computerEngines?: { agentDesktop: AgentDesktopEngineStatus };
  /** Absent from daemons where the browser still ran on desktops. */
  browser?: AgentBrowserStatus;
  /** Agents also get the `camera_*` tools (needs `enabled`). Off by default; absent from daemons without the camera. */
  cameraEnabled?: boolean;
  /** Absent from daemons without the camera. */
  camera?: AgentCameraStatus;
};

// ---- Agent camera ------------------------------------------------------------

/**
 * How a camera session keeps frames. `fixed`: evenly spaced at
 * {@link AgentCameraCapture.fps}. `dynamic`: only while the picture changes,
 * more the more it changes; {@link AgentCameraCapture.sensitivity} (1–100)
 * sets how small a change counts (higher keeps more).
 */
export type AgentCameraCaptureMode = 'fixed' | 'dynamic';

export type AgentCameraCapture = {
  mode: AgentCameraCaptureMode;
  /** Frames per second (`fixed`). */
  fps: number;
  /** 1–100 (`dynamic`). */
  sensitivity: number;
};

/** The macOS (TCC) camera permission of the TodeX backend on its host. */
export type AgentCameraPermission = 'granted' | 'denied' | 'restricted' | 'notDetermined';

export type AgentCameraDevice = {
  id: string;
  name: string;
  /** Plugged in now. */
  connected: boolean;
  /** Agents may use it. */
  allowed: boolean;
  /** A session is recording it. */
  inUse: boolean;
};

export type AgentCameraLimits = {
  fps: { min: number; max: number };
  sensitivity: { min: number; max: number };
  maxSeconds: { min: number; max: number };
  maxFrames: { min: number; max: number };
};

/** {@link AgentDesktopSettings.camera}. */
export type AgentCameraStatus = {
  /** The host can use cameras at all (macOS only for now). */
  supported: boolean;
  reason?: string | null;
  host: string;
  platform: string;
  permission: AgentCameraPermission;
  /** macOS's prompt is on the host's screen; poll while set. */
  permissionRequest: boolean;
  /** Connected cameras, then allowed ones that are unplugged. */
  devices: AgentCameraDevice[];
  /** Offered first on approval cards. */
  defaultDevice?: string | null;
  /** What approval cards start with. */
  capture: AgentCameraCapture;
  /** Every session stops after this long ... */
  maxSeconds: number;
  /** ... or this many frames. */
  maxFrames: number;
  limits: AgentCameraLimits;
};

/** `PUT /v2/agent-desktop/camera`; absent fields stay. Returns {@link AgentDesktopSettings}. */
export type AgentCameraSettingsUpdate = {
  enabled?: boolean;
  /** Device ids agents may use (replaces the list). */
  allowed?: string[];
  defaultDevice?: string | null;
  capture?: AgentCameraCapture;
  maxSeconds?: number;
  maxFrames?: number;
};

/** An app on the daemon's host. `id` is what `computer_act open_app` takes
 * (macOS bundle id, Windows exe name, Linux desktop id) and has no spaces. */
export type HostApp = { id: string; name: string; running: boolean };

/** `GET /v2/agent-desktop/computer/apps`: running apps first, then installed ones. */
export type HostApps = { apps: HostApp[] };

export type AgentBrowserProfile = { id: string; name: string; createdAt: number };

/** `GET /v2/agent-browser/profiles` (and the result of every profile change). */
export type AgentBrowserProfiles = {
  profiles: AgentBrowserProfile[];
  /** Workspace id (path for workspaces without one) → profile id. */
  workspaces: Record<string, string>;
};

/**
 * `{ type: 'agentBrowser.frame', payload }` after `agentBrowser.watch
 * { conversationId }` on `/v2/ws` (until `agentBrowser.unwatch`). The
 * backend keeps one latest-frame slot per watch: a newer frame replaces an
 * unsent one, so a slow connection skips frames instead of queueing them.
 * Ordinary socket messages go first, but at least one frame is sent per 16
 * of them so the view never starves. `closed` means the conversation has no
 * tab; it is always delivered, never dropped or replaced.
 */
export type AgentBrowserFrame =
  | { conversationId: string; seq: number; mimeType: 'image/jpeg'; data: string; width: number; height: number; closed?: never }
  | { conversationId: string; closed: true };

/** Request-id prefix of `agentBrowser.watch`; its failures are not user-facing. */
export const AGENT_BROWSER_WATCH_ID_PREFIX = 'abw';
/** Request-id prefix of `agentBrowser.unwatch`. */
export const AGENT_BROWSER_UNWATCH_ID_PREFIX = 'abu';

/** Whether a `server.error` id belongs to a live-view watch or unwatch request. */
export function isAgentBrowserWatchRequestId(id: unknown): boolean {
  return typeof id === 'string'
    && (id.startsWith(`${AGENT_BROWSER_WATCH_ID_PREFIX}-`) || id.startsWith(`${AGENT_BROWSER_UNWATCH_ID_PREFIX}-`));
}

/** A failed tool call as journaled in `desktop.*.action` events. */
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
 * - `TAB_LIMIT`: too many agent tabs (or browser profiles) on the host.
 * - `BROWSER_INSTALLING`: the daemon is still downloading Chromium.
 * - `SENSITIVE_ACTION`: the action needs the user's confirmation; the daemon
 *   asks and retries confirmed.
 * - `USER_ACTIVE`: the user is using the pointer; retry shortly.
 * - `TARGET_BLOCKED`: the target app or window may never be controlled.
 * - `APP_CONFIRM`: first action in this app; the daemon asks and retries.
 * - `PERMISSION_REQUIRED`: Screen Recording or Accessibility is not granted.
 * - `SCREEN_BUSY`: another conversation controls the screen.
 * - `UNAVAILABLE`: the host cannot run it (no graphical session, ...).
 */
export type ExecutorErrorCode =
  | 'NAVIGATION_BLOCKED'
  | 'NO_TAB'
  | 'REF_NOT_FOUND'
  | 'TAB_LIMIT'
  | 'BROWSER_INSTALLING'
  | 'SENSITIVE_ACTION'
  | 'USER_ACTIVE'
  | 'TARGET_BLOCKED'
  | 'APP_CONFIRM'
  | 'PERMISSION_REQUIRED'
  | 'SCREEN_BUSY'
  | 'UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'EXECUTOR_FAILED';

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

/** `desktop.browser.grant`: the conversation may (no longer) use the browser. */
export type DesktopBrowserGrantEvent = {
  status: 'granted' | 'revoked';
  deviceId?: string;
  deviceName?: string;
  reason?: string;
};

/**
 * `desktop.browser.tab`: the conversation's tab is gone without a
 * `browser_close` call. `idle` (unused too long), `crash` (the page or the
 * browser died), `user` (closed from the UI), `revoked` (the grant was
 * withdrawn), `restart` (the browser was restarted).
 */
export type DesktopBrowserTabEvent = {
  status: 'closed';
  reason: 'idle' | 'crash' | 'user' | 'revoked' | 'restart';
};

/** `permission.requested.kind` of the per-conversation first grant. */
export const DESKTOP_BROWSER_GRANT_KIND = 'desktop_browser';
/** `permission.requested.kind` of a single sensitive action. */
export const DESKTOP_BROWSER_ACTION_KIND = 'desktop_browser_action';
/**
 * `permission.requested.kind` of opening a host beyond the daemon's computer
 * (a public site or the local network); any device. Options: `once` (this
 * conversation), `always` (saved; see `getAgentBrowserHosts`), `reject`.
 */
export const DESKTOP_BROWSER_HOST_KIND = 'desktop_browser_host';
/** First action in an app during a conversation; any device. */
export const DESKTOP_COMPUTER_APP_KIND = 'desktop_computer_app';
/** A sensitive Computer Use action (password field); any device. */
export const DESKTOP_COMPUTER_ACTION_KIND = 'desktop_computer_action';
/**
 * `permission.requested.kind` of a `camera_start`; any device. Options:
 * `once`, `conversation` (until the conversation ends or it is revoked),
 * `reject`. An allow may carry {@link DesktopCameraChoice} as `data`.
 * While it is open, `getCameraFrame(conversationId, deviceId)` previews any
 * camera in {@link DesktopCameraDetails.devices}.
 */
export const DESKTOP_CAMERA_KIND = 'desktop_camera';

/** `details` of a {@link DESKTOP_CAMERA_KIND} permission. */
export type DesktopCameraDetails = {
  /** The computer the cameras are on. */
  host: string;
  /** Allowed, connected cameras the person may pick from. */
  devices: { id: string; name: string }[];
  /** Preselected: the agent's pick or the default. */
  deviceId: string;
  capture: AgentCameraCapture;
  maxSeconds: number;
  maxFrames: number;
  limits: Pick<AgentCameraLimits, 'fps' | 'sensitivity'>;
};

/** `data` of an allow answer to a {@link DESKTOP_CAMERA_KIND} card. */
export type DesktopCameraChoice = {
  deviceId: string;
  capture: AgentCameraCapture;
};

/** `desktop.camera.grant`: a `camera_start` was allowed, or the conversation's camera taken back. */
export type DesktopCameraGrantEvent = {
  status: 'granted' | 'revoked';
  /** `once`, or `conversation` (later starts on that camera skip the card). */
  scope?: 'once' | 'conversation';
  deviceId?: string;
  deviceName?: string;
  capture?: AgentCameraCapture;
  approvedBy?: string;
  /** `user`, `settings`. */
  reason?: string;
};

/**
 * Why a camera session ended: `agent` (camera_stop), `time_limit`,
 * `frame_limit`, `turn_ended`, `revoked`, `user` (stop button),
 * `camera_lost`, `failed`.
 */
export type DesktopCameraEndReason =
  | 'agent' | 'time_limit' | 'frame_limit' | 'turn_ended' | 'revoked' | 'user' | 'camera_lost' | 'failed';

/** `desktop.camera.session`: a camera session started or ended. */
export type DesktopCameraSessionEvent =
  | {
    status: 'started';
    sessionId: string;
    deviceId: string;
    deviceName: string;
    capture: AgentCameraCapture;
    maxSeconds: number;
    maxFrames: number;
    /** Where the frames go, on the backend's computer. */
    directory: string;
  }
  | {
    status: 'ended';
    sessionId: string;
    reason: DesktopCameraEndReason;
    frames: number;
    durationMs: number;
    directory: string;
  };

/** A running session's progress in {@link CameraFrame}. */
export type AgentCameraProgress = {
  frames: number;
  elapsedMs: number;
  /** How much the picture changes now, in kbps. */
  changeKbps: number;
  /** Frames per second being kept now (0 while still, in dynamic capture). */
  rateFps: number;
};

/**
 * `GET /v2/conversations/{id}/agent-desktop/camera[?deviceId]`: the
 * conversation's recording camera, or a camera its open card offers (404
 * otherwise). `GET /v2/agent-desktop/camera/preview?deviceId` (settings) has
 * no `session`. Polling keeps the camera on; it turns off a few seconds after
 * the last poll unless a session records it.
 */
export type CameraFrame = {
  mimeType: string;
  dataUrl: string;
  deviceId: string;
  session?: {
    sessionId: string;
    deviceName: string;
    capture: AgentCameraCapture;
    maxSeconds: number;
    maxFrames: number;
    progress: AgentCameraProgress;
  };
};

/**
 * `desktop.computer.grant`: the conversation's Computer Use grant, which the
 * person at the host confirms there (`requested` → `granted` / `declined`),
 * or the user revoked.
 */
export type DesktopComputerGrantEvent = {
  status: 'requested' | 'granted' | 'declined' | 'revoked';
  deviceId?: string;
  /** The host's name. */
  deviceName?: string;
  reason?: string;
};

/**
 * `GET /v2/conversations/{id}/agent-desktop/frame[?capability=browser]`: the
 * host's screen (Computer Use, 404 unless the conversation controls it) or
 * the conversation's browser tab, now.
 */
export type ComputerFrame = { mimeType: string; dataUrl: string };

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
  /**
   * Where the action landed, as fractions of the display the live view
   * shows (0 at its top-left, 1 at its bottom-right). Absent when the action
   * has no point or it lies on another display.
   */
  point?: { x: number; y: number };
  error?: ExecutorFailure;
  shotId?: string;
  deviceId: string;
  deviceName: string;
};

/** `details` of a {@link DESKTOP_BROWSER_GRANT_KIND} permission. */
export type DesktopBrowserGrantDetails = {
  /** The computer the browser runs on. */
  host: string;
};

/** `details` of a {@link DESKTOP_BROWSER_HOST_KIND} permission. */
export type DesktopBrowserHostDetails = {
  /** Host name or address, lowercase, without port. */
  host: string;
  /** The host is (or resolves to) an address on the local network. */
  localNetwork: boolean;
};

/** `GET /v2/agent-browser/hosts`: hosts always allowed beyond the daemon's computer. */
export type AgentBrowserHosts = { hosts: string[] };

/** `GET /v2/conversations/{id}/agent-shots/{shotId}`. */
export type AgentShot = { shotId: string; mimeType: string; dataUrl: string };

export function isAgentComputerTool(value: unknown): value is AgentComputerTool {
  return typeof value === 'string' && (AGENT_COMPUTER_TOOLS as readonly string[]).includes(value);
}

export function isAgentCameraTool(value: unknown): value is AgentCameraTool {
  return typeof value === 'string' && (AGENT_CAMERA_TOOLS as readonly string[]).includes(value);
}

export function isAgentBrowserTool(value: unknown): value is AgentBrowserTool {
  return typeof value === 'string' && (AGENT_BROWSER_TOOLS as readonly string[]).includes(value);
}
