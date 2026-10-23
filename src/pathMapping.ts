// Host ↔ backend path mapping for backends whose filesystem differs from the
// client's: a container that mounts host folders at other paths (Windows
// hosts, `/workspace/<name>` layouts). The backend publishes the pairs in
// `GET /v2/version` (`pathMappings`, trusted part) and its deployment kind
// (`deployment`, also unauthenticated). Older backends send neither: treat
// them as `host` with no mappings.
//
// Mapping is a longest-prefix match on whole path segments. Paths with `.` or
// `..` segments, relative paths and malformed mappings never map, so a mapped
// path cannot leave the folder its mapping names. Backend paths are POSIX
// (the container is Linux) and compared case-sensitively; host paths follow
// `windows`: `\` and `/` are equivalent, drive letters and names compare
// case-insensitively, and mapped host paths use `\`.

/** Where the backend runs. */
export type BackendDeployment = 'host' | 'container';

/** One published folder: `hostPath` on the client's machine is
 * `backendPath` on the backend. */
export type PathMapping = { hostPath: string; backendPath: string };

export type PathMappingOptions = {
  /** The host side uses Windows paths. */
  windows: boolean;
};

/** `/v2/version`'s `deployment`; anything else (or absence) is `host`. */
export function parseBackendDeployment(value: unknown): BackendDeployment {
  return value === 'container' ? 'container' : 'host';
}

/** `/v2/version`'s `pathMappings`, keeping only well-formed string pairs. */
export function parsePathMappings(value: unknown): PathMapping[] {
  if (!Array.isArray(value)) return [];
  const mappings: PathMapping[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { hostPath, backendPath } = item as Record<string, unknown>;
    if (typeof hostPath === 'string' && typeof backendPath === 'string' && hostPath.trim() && backendPath.trim()) {
      mappings.push({ hostPath, backendPath });
    }
  }
  return mappings;
}

type ParsedPath = {
  /** `/` (POSIX), `C:` (drive, upper-cased) or `//` (UNC). */
  root: string;
  segments: string[];
};

function parsePath(path: string, windows: boolean): ParsedPath | null {
  let rest = path.trim();
  if (!rest) return null;
  let root: string;
  if (windows) {
    rest = rest.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):(?=\/|$)/.exec(rest);
    if (drive) {
      root = `${drive[1].toUpperCase()}:`;
      rest = rest.slice(2);
    } else if (rest.startsWith('//')) {
      root = '//';
      rest = rest.slice(2);
    } else if (rest.startsWith('/')) {
      root = '/';
    } else {
      return null;
    }
  } else if (rest.startsWith('/')) {
    root = '/';
  } else {
    return null;
  }
  const segments = rest.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  // A UNC path needs its server and share before anything maps under it.
  if (root === '//' && segments.length < 2) return null;
  return { root, segments };
}

function formatPath(parsed: ParsedPath, windows: boolean): string {
  if (!windows) return `/${parsed.segments.join('/')}`;
  if (parsed.root === '//') return `\\\\${parsed.segments.join('\\')}`;
  if (parsed.root === '/') return `\\${parsed.segments.join('\\')}`;
  return `${parsed.root}\\${parsed.segments.join('\\')}`;
}

function sameSegment(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Segments of `path` below `prefix`, or null when `prefix` does not contain it. */
function remainderBelow(path: ParsedPath, prefix: ParsedPath, caseInsensitive: boolean): string[] | null {
  if (path.root !== prefix.root || prefix.segments.length > path.segments.length) return null;
  for (let index = 0; index < prefix.segments.length; index += 1) {
    if (!sameSegment(path.segments[index], prefix.segments[index], caseInsensitive)) return null;
  }
  return path.segments.slice(prefix.segments.length);
}

function mapPath(
  path: string,
  mappings: readonly PathMapping[],
  from: 'hostPath' | 'backendPath',
  windows: boolean,
): string | null {
  const to = from === 'hostPath' ? 'backendPath' : 'hostPath';
  const fromWindows = from === 'hostPath' && windows;
  const toWindows = to === 'hostPath' && windows;
  const parsed = parsePath(path, fromWindows);
  if (!parsed) return null;
  let best: { depth: number; target: ParsedPath; rest: string[] } | null = null;
  for (const mapping of mappings) {
    const source = parsePath(mapping[from], fromWindows);
    const target = parsePath(mapping[to], toWindows);
    if (!source || !target) continue;
    const rest = remainderBelow(parsed, source, fromWindows);
    if (rest && (!best || source.segments.length > best.depth)) {
      best = { depth: source.segments.length, target, rest };
    }
  }
  if (!best) return null;
  return formatPath({ root: best.target.root, segments: [...best.target.segments, ...best.rest] }, toWindows);
}

/** The backend path of host path `path`, or null when no mapping covers it. */
export function mapHostPathToBackend(path: string, mappings: readonly PathMapping[], options: PathMappingOptions): string | null {
  return mapPath(path, mappings, 'hostPath', options.windows);
}

/** The host path of backend path `path`, or null when no mapping covers it.
 * With `windows`, the result uses `\` separators. */
export function mapBackendPathToHost(path: string, mappings: readonly PathMapping[], options: PathMappingOptions): string | null {
  return mapPath(path, mappings, 'backendPath', options.windows);
}
