import { MESH_RELAY_PREFIX, meshRelayUrl, type MeshChain } from './mesh';

/**
 * Picking how a client reaches a group node: every direct address and a
 * relay through every node that may relay (TodeX_backend docs/mesh-v1.md
 * "Relay") are probed at once; the first that answers as that node is used,
 * and every minute the paths are measured again and the client moves to one
 * clearly faster. A relay counts as slower than it measures (see
 * {@link meshPathCost}), so a client that got in through a relay moves to a
 * direct address as soon as one answers about as fast. Shared by the
 * desktop, web and mobile clients; they own the timers, the links and the
 * relay tickets.
 */

/** One way to reach a node: `url` is its base address, `via` the relay node. */
export type MeshPath = {
  /** Stable across ticket renewals: the address, or `relay:<node id>`. */
  key: string;
  url: string;
  via?: string;
};

/** Round-trip times of a path's recent probes (`null`: it failed), newest last. */
export type MeshPathSamples = Array<number | null>;

/** How many recent probes a path is judged on. */
export const MESH_PATH_SAMPLES = 3;
/** A probe that has not answered by then failed. */
export const MESH_PATH_PROBE_TIMEOUT_MS = 3_000;
/** How often an open node's paths are measured again. */
export const MESH_PATH_MEASURE_MS = 60_000;
/** Least time between two moves to a faster path. */
export const MESH_PATH_SWITCH_COOLDOWN_MS = 120_000;
/** A faster path must take at most this share of the current one's time… */
const SWITCH_RATIO = 0.7;
/** …and save at least this many milliseconds. */
const SWITCH_MIN_GAIN_MS = 40;
/** A relayed path is judged as this many times its time… */
const RELAY_COST_RATIO = 1.5;
/** …plus this many milliseconds. */
const RELAY_COST_MS = 40;

/**
 * The paths to `targetNodeId`: its direct `urls` (best first), then a relay
 * through each node in `relays` that may relay to it. A relay is left out
 * when this device does not relay, the target refuses relaying, the relay
 * node is the target or `denied`. Hubs come first, then `preferred` relays.
 */
export function meshPathCandidates(input: {
  chain: MeshChain;
  targetNodeId: string;
  urls: readonly string[];
  /** Relay nodes and the address each is reached at. */
  relays: ReadonlyArray<{ nodeId: string; url: string }>;
  relayEnabled: boolean;
  /** A signed relay ticket for `relayNodeId` → the target. */
  ticketFor: (relayNodeId: string) => string;
}): MeshPath[] {
  const direct = [...new Set(input.urls.map(trimSlash))].map((url) => ({ key: url, url }));
  const target = input.chain.head.members.find((member) => member.id === input.targetNodeId);
  if (!input.relayEnabled || !target || target.kind !== 'node' || target.relayTarget === false) return direct;
  const roleOf = (nodeId: string) => input.chain.head.members.find((member) => member.id === nodeId)?.relay ?? 'allowed';
  const rankOf = (nodeId: string) => {
    if (input.chain.head.members.find((member) => member.id === nodeId)?.hub) return 2;
    return roleOf(nodeId) === 'preferred' ? 1 : 0;
  };
  const seen = new Set<string>();
  const relays = input.relays
    .filter((relay) => {
      const member = input.chain.head.members.find((item) => item.id === relay.nodeId);
      if (!member || member.kind !== 'node' || relay.nodeId === input.targetNodeId || roleOf(relay.nodeId) === 'denied') return false;
      // A relay reached through a relay is no use: only direct addresses.
      if (relay.url.includes(MESH_RELAY_PREFIX) || seen.has(relay.nodeId)) return false;
      seen.add(relay.nodeId);
      return true;
    })
    .sort((a, b) => rankOf(b.nodeId) - rankOf(a.nodeId));
  return [
    ...direct,
    ...relays.map((relay) => ({
      key: `relay:${relay.nodeId}`,
      url: meshRelayUrl(relay.url, input.targetNodeId, input.ticketFor(relay.nodeId)),
      via: relay.nodeId,
    })),
  ];
}

/**
 * The round trip of `GET <url>/v2/version` in milliseconds, or null when it
 * failed, timed out or answered as another node (its `nodeId`; a backend too
 * old to report one is taken at its word).
 */
export async function probeMeshPath(
  url: string,
  targetNodeId: string,
  options: { fetchImpl: typeof fetch; timeoutMs?: number; now?: () => number; signal?: AbortSignal },
): Promise<number | null> {
  const now = options.now ?? (() => Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MESH_PATH_PROBE_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const started = now();
  try {
    const response = await options.fetchImpl(`${trimSlash(url)}/v2/version`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { name?: unknown; nodeId?: unknown };
    if (body.name !== 'todex-agentd') return null;
    if (typeof body.nodeId === 'string' && body.nodeId !== targetNodeId) return null;
    return Math.max(0, now() - started);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Probes every path at once and resolves with the first that answered (or
 * null when none did); `onResult` sees every probe's outcome, including the
 * ones that finish after the winner.
 */
export function raceMeshPaths(
  paths: readonly MeshPath[],
  probe: (path: MeshPath) => Promise<number | null>,
  onResult?: (path: MeshPath, ms: number | null) => void,
): Promise<{ path: MeshPath; ms: number } | null> {
  if (!paths.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = paths.length;
    let settled = false;
    for (const path of paths) {
      void probe(path).catch(() => null).then((ms) => {
        onResult?.(path, ms);
        pending -= 1;
        if (!settled && ms !== null) {
          settled = true;
          resolve({ path, ms });
        } else if (!settled && pending === 0) {
          settled = true;
          resolve(null);
        }
      });
    }
  });
}

/** `samples` with `ms` added, keeping the last {@link MESH_PATH_SAMPLES}. */
export function addMeshPathSample(samples: MeshPathSamples | undefined, ms: number | null): MeshPathSamples {
  return [...(samples ?? []), ms].slice(-MESH_PATH_SAMPLES);
}

/** The median of a path's answered probes; null when its last probe failed or none answered. */
export function meshPathLatency(samples: MeshPathSamples | undefined): number | null {
  if (!samples?.length || samples[samples.length - 1] === null) return null;
  const answered = samples.filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
  return answered.length ? answered[Math.floor(answered.length / 2)] : null;
}

/**
 * What a path is judged on: its latency, and for a relayed path (key
 * `relay:…`) 1.5 times that plus 40 ms, since a relay costs the relay node
 * bandwidth and fails with it. Null when the path does not answer.
 */
export function meshPathCost(key: string, samples: MeshPathSamples | undefined): number | null {
  const ms = meshPathLatency(samples);
  if (ms === null) return null;
  return isRelayKey(key) ? ms * RELAY_COST_RATIO + RELAY_COST_MS : ms;
}

/**
 * The key of the path to move to, or null to stay, by {@link meshPathCost}.
 * A path whose last probe failed is left for the cheapest one that answers;
 * a relayed path for a direct one that costs no more, at once. Otherwise the
 * cheapest must cost at most 70% of the current path and save 40 ms, and
 * the last move must be two minutes old, so the client does not flap.
 */
export function pickMeshPath(input: {
  currentKey: string | null;
  samples: ReadonlyMap<string, MeshPathSamples>;
  now: number;
  lastSwitchAt: number;
}): string | null {
  let best: { key: string; cost: number } | null = null;
  for (const [key, samples] of input.samples) {
    const cost = meshPathCost(key, samples);
    if (cost !== null && (!best || cost < best.cost)) best = { key, cost };
  }
  if (!best || best.key === input.currentKey) return null;
  const current = input.currentKey ? meshPathCost(input.currentKey, input.samples.get(input.currentKey)) : null;
  if (current === null) return best.key;
  if (input.currentKey && isRelayKey(input.currentKey) && !isRelayKey(best.key)) return best.key;
  if (input.now - input.lastSwitchAt < MESH_PATH_SWITCH_COOLDOWN_MS) return null;
  return best.cost <= current * SWITCH_RATIO && current - best.cost >= SWITCH_MIN_GAIN_MS ? best.key : null;
}

function isRelayKey(key: string): boolean {
  return key.startsWith('relay:');
}

/** The key of the path `url` is (a relay address keys by its relay node). */
export function meshPathKeyOf(url: string, via?: string): string {
  return via ? `relay:${via}` : trimSlash(url);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
