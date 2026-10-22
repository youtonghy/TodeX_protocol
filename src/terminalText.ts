/**
 * Terminal text helpers shared by the desktop and web terminal views: paste
 * safety, the OSC sequences shell integration and programs send, and file
 * path links. Platform-agnostic: no DOM or xterm types.
 */

/**
 * Control characters a paste must not deliver: they could end bracketed
 * paste early (ESC) or act as keystrokes (^C, ^U, ^W, ^Z…). Tab and line
 * breaks stay. The same rule Ghostty applies, widened to all C0/C1 controls.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_PASTE_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

export function sanitizePaste(text: string): string {
  return text.replace(UNSAFE_PASTE_CHARACTERS, ' ');
}

/**
 * A paste the shell would run line by line as it arrives: it has a line
 * break and the program did not turn on bracketed paste.
 */
export function pasteNeedsConfirmation(text: string, bracketedPaste: boolean): boolean {
  return !bracketedPaste && /[\r\n]/.test(text);
}

/**
 * OSC 7 working directory: `file://host/path` (percent-encoded) or Kitty's
 * `kitty-shell-cwd://host/path` (raw). Returns the path, or null.
 */
export function parseOsc7(data: string): string | null {
  const match = /^(file|kitty-shell-cwd):\/\/[^/]*(\/.*)$/.exec(data);
  if (!match) return null;
  if (match[1] === 'kitty-shell-cwd') return match[2];
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

export type Osc133Mark =
  | { kind: 'prompt' }
  | { kind: 'input' }
  | { kind: 'command' }
  | { kind: 'finished'; exitCode: number | null };

/**
 * OSC 133 semantic prompt marks: A prompt start, B input start, C command
 * output start, D[;status] command finished. Options after `;` (e.g. fish's
 * `A;click_events=1`) are ignored.
 */
export function parseOsc133(data: string): Osc133Mark | null {
  const [mark, ...params] = data.split(';');
  switch (mark) {
    case 'A':
    case 'P':
      return { kind: 'prompt' };
    case 'B':
      return { kind: 'input' };
    case 'C':
      return { kind: 'command' };
    case 'D': {
      const status = params[0] !== undefined && /^-?\d+$/.test(params[0]) ? Number(params[0]) : null;
      return { kind: 'finished', exitCode: status };
    }
    default:
      return null;
  }
}

export type TerminalNotification = { title: string; body: string };

const NOTIFICATION_TEXT_LIMIT = 200;

function cleanNotificationText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > NOTIFICATION_TEXT_LIMIT ? `${clean.slice(0, NOTIFICATION_TEXT_LIMIT - 1)}…` : clean;
}

/**
 * Desktop notifications programs send: OSC 9 `body` (iTerm2) and OSC 777
 * `notify;title;body` (rxvt). OSC 9;4 is a progress report, not a notice.
 */
export function parseTerminalNotification(ident: 9 | 777, data: string): TerminalNotification | null {
  if (ident === 9) {
    if (/^4(;|$)/.test(data)) return null;
    const body = cleanNotificationText(data);
    return body ? { title: '', body } : null;
  }
  const [kind, title = '', ...rest] = data.split(';');
  if (kind !== 'notify') return null;
  const notification = { title: cleanNotificationText(title), body: cleanNotificationText(rest.join(';')) };
  return notification.title || notification.body ? notification : null;
}

export type TerminalFileLink = {
  /** Offset of the link in the line (UTF-16 units). */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
};

/**
 * File references in terminal output: `src/app.ts`, `./a/b.rs:12`,
 * `/abs/file.go:3:7`, `~/x/y.md`. A bare name counts only with a line
 * number (`main.c:10`), so ordinary words with dots are not links. URLs are
 * left to the URL link provider.
 */
const FILE_LINK_PATTERN = /(?<![\w/.:~-])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?(?![\w/])/g;

export function findFileLinks(text: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  for (const match of text.matchAll(FILE_LINK_PATTERN)) {
    const [whole, path, line, column] = match;
    const index = match.index ?? 0;
    if (/^[a-z][\w+.-]*:\/\//i.test(text.slice(Math.max(0, index - 12), index + whole.length))) continue;
    if (!path.includes('/') && line === undefined) continue;
    if (/^\d+(\.\d+)+$/.test(path)) continue;
    links.push({
      start: index,
      end: index + whole.length,
      path,
      ...(line !== undefined ? { line: Number(line) } : {}),
      ...(column !== undefined ? { column: Number(column) } : {}),
    });
  }
  return links;
}

/**
 * Resolves a linked path against the shell's directory. Returns null for
 * paths outside `root`, so links only open files of the workspace.
 */
export function resolveTerminalPath(path: string, cwd: string, root: string, home = ''): string | null {
  let absolute: string;
  if (path.startsWith('~/')) {
    if (!home) return null;
    absolute = `${home}/${path.slice(2)}`;
  } else if (path.startsWith('/')) {
    absolute = path;
  } else {
    if (!cwd) return null;
    absolute = `${cwd}/${path}`;
  }
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const normalized = `/${parts.join('/')}`;
  const base = root.replace(/\/+$/, '');
  if (!base) return null;
  return normalized === base || normalized.startsWith(`${base}/`) ? normalized : null;
}

/** Images pasted or dropped into a terminal go to the PTY's machine and their
 * path is pasted; agent CLIs (Claude Code, Codex) attach such paths. */
export const TERMINAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Formats the agents read as they are; others are converted to PNG. */
export const TERMINAL_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
/** Where SSH terminals' pasted images go, under the remote home. */
export const TERMINAL_REMOTE_IMAGE_DIR = '.cache/todex/paste';
/** Pasted images older than this are removed from the remote directory. */
export const TERMINAL_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isTerminalImageType(mimeType: string): boolean {
  return /^image\//i.test(mimeType);
}

export function terminalImageNeedsPng(mimeType: string): boolean {
  return !(mimeType.toLowerCase() in TERMINAL_IMAGE_TYPES);
}

/**
 * A file name agents recognize as an image and shells need no quoting for:
 * `paste-20261022-153045-1.png` (lowercase extension, no spaces).
 */
export function terminalImageName(mimeType: string, when: Date, index = 0): string {
  const extension = TERMINAL_IMAGE_TYPES[mimeType.toLowerCase()] ?? 'png';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `paste-${stamp}-${index + 1}.${extension}`;
}

/** A remote pasted image the cleanup may remove. */
export function isStaleTerminalImage(name: string, modifiedAtMs: number | undefined, now: number): boolean {
  return /^paste-\d{8}-\d{6}-\d+\.(png|jpg|gif|webp)$/.test(name)
    && modifiedAtMs !== undefined
    && now - modifiedAtMs > TERMINAL_IMAGE_TTL_MS;
}
