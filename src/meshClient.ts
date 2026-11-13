// Device groups as a client keeps them (TodeX_backend docs/mesh-v1.md): one
// stored record per group (its roster chain, the other nodes' signed info,
// the addresses that reached each node), merged with what each node answers,
// and the order a node's addresses are tried in. Shared by every client;
// each keeps the record and the group's keys in its own stores.

import {
  meshChainWins,
  meshRelayExpiry,
  verifyMeshChain,
  verifyMeshNodeInfo,
  type MeshChain,
  type MeshMember,
  type MeshNodeInfo,
  type MeshSignedDoc,
} from './mesh';
import { normalizeServerUrl } from './todex';

/** Addresses kept per node. */
const MAX_NODE_URLS = 16;

export type StoredMeshGroup = {
  groupId: string;
  /** From the invite until the first chain arrives. */
  name: string;
  /** Empty while a device join waits for its first sync. */
  chain: MeshSignedDoc[];
  /** Other nodes' signed info, by node id. */
  nodeInfos: Record<string, MeshSignedDoc>;
  /** Addresses that reached each node, last successful first. */
  nodeUrls: Record<string, string[]>;
  /** This device's member id. */
  deviceId: string;
  joinedAt: number;
};

export function normalizeStoredMeshGroups(value: unknown): StoredMeshGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = raw as Partial<StoredMeshGroup> | null;
    if (!item || typeof item.groupId !== 'string' || typeof item.deviceId !== 'string') return [];
    return [{
      groupId: item.groupId,
      name: typeof item.name === 'string' ? item.name : '',
      chain: Array.isArray(item.chain) ? item.chain.filter(isDoc) : [],
      nodeInfos: item.nodeInfos && typeof item.nodeInfos === 'object' ? Object.fromEntries(Object.entries(item.nodeInfos).filter(([, doc]) => isDoc(doc))) : {},
      nodeUrls: item.nodeUrls && typeof item.nodeUrls === 'object'
        ? Object.fromEntries(Object.entries(item.nodeUrls).map(([id, urls]) => [id, Array.isArray(urls) ? urls.filter((url): url is string => typeof url === 'string') : []]))
        : {},
      deviceId: item.deviceId,
      joinedAt: typeof item.joinedAt === 'number' ? item.joinedAt : Date.now(),
    }];
  });
}

function isDoc(value: unknown): value is MeshSignedDoc {
  return Boolean(value) && typeof (value as MeshSignedDoc).body === 'string' && typeof (value as MeshSignedDoc).sig === 'string';
}

/** The verified chain of a stored group; `null` while it has none or when
 * the stored one no longer verifies. */
export function storedChain(group: StoredMeshGroup): MeshChain | null {
  if (!group.chain.length) return null;
  try {
    const chain = verifyMeshChain(group.chain);
    return chain.groupId === group.groupId ? chain : null;
  } catch {
    return null;
  }
}

/** Verified info of every node of `chain` (highest `seq`). */
export function nodeInfosOf(group: StoredMeshGroup, chain: MeshChain): Map<string, MeshNodeInfo> {
  const infos = new Map<string, MeshNodeInfo>();
  for (const member of chain.head.members) {
    if (member.kind !== 'node') continue;
    const doc = group.nodeInfos[member.id];
    if (!doc) continue;
    try {
      infos.set(member.id, verifyMeshNodeInfo(doc, member.publicKey));
    } catch {
      // A document the roster key does not sign is ignored.
    }
  }
  return infos;
}

/** Keeps the higher-`seq` verified info per node; returns whether any changed. */
export function mergeNodeInfos(group: StoredMeshGroup, chain: MeshChain, docs: readonly MeshSignedDoc[]): boolean {
  let changed = false;
  for (const doc of docs) {
    for (const member of chain.head.members) {
      if (member.kind !== 'node') continue;
      let info: MeshNodeInfo;
      try {
        info = verifyMeshNodeInfo(doc, member.publicKey);
      } catch {
        continue;
      }
      const current = group.nodeInfos[member.id];
      let currentSeq = -1;
      if (current) {
        try {
          currentSeq = verifyMeshNodeInfo(current, member.publicKey).seq;
        } catch {
          currentSeq = -1;
        }
      }
      if (info.seq > currentSeq) {
        group.nodeInfos[member.id] = doc;
        changed = true;
      }
    }
  }
  return changed;
}

/** What a sync with one node decided. */
export type MeshSyncOutcome = {
  group: StoredMeshGroup;
  /** The stored group changed (persist and re-render). */
  changed: boolean;
  /** The node lacks the winning chain or some node info: push both. */
  push: boolean;
  /** The winning chain no longer lists this device: forget the group. */
  removed: boolean;
};

/**
 * Merges what node `nodeId` answered for `group`: its chain (when it wins
 * the fork rule, or when this device has none yet and the chain lists it),
 * its own info and the infos it stores. A group this device has no chain for
 * accepts only a chain of the same group that lists `group.deviceId`.
 */
export function mergeNodeState(
  stored: StoredMeshGroup,
  remote: { nodeId: string; nodeInfo: MeshSignedDoc; chain?: MeshSignedDoc[]; nodeInfos?: MeshSignedDoc[] },
): MeshSyncOutcome {
  const group: StoredMeshGroup = { ...stored, nodeInfos: { ...stored.nodeInfos }, nodeUrls: { ...stored.nodeUrls } };
  let changed = false;
  let local = storedChain(group);
  let remoteChain: MeshChain | null = null;
  if (remote.chain?.length) {
    try {
      const candidate = verifyMeshChain(remote.chain);
      if (candidate.groupId === group.groupId) remoteChain = candidate;
    } catch {
      remoteChain = null;
    }
  }
  if (remoteChain && (local ? meshChainWins(remoteChain, local) : remoteChain.head.members.some((member) => member.id === group.deviceId))) {
    group.chain = remoteChain.docs;
    group.name = remoteChain.head.name;
    local = remoteChain;
    changed = true;
  }
  if (!local) return { group, changed, push: false, removed: false };
  if (mergeNodeInfos(group, local, [remote.nodeInfo, ...(remote.nodeInfos ?? [])])) changed = true;
  const removed = !local.head.members.some((member) => member.id === group.deviceId && member.kind === 'device');
  const listsNode = local.head.members.some((member) => member.id === remote.nodeId);
  // The node is behind (or not in the group yet) or misses some node info.
  const remoteHead = remoteChain ? remoteChain.headHash : null;
  const behind = !remoteHead || meshChainWins(local, remoteChain!);
  const known = new Set((remote.nodeInfos ?? []).map((doc) => doc.body));
  const missingInfo = Object.entries(group.nodeInfos).some(([id, doc]) => id !== remote.nodeId && !known.has(doc.body));
  return { group, changed, push: !removed && (behind || (listsNode && missingInfo)), removed };
}

/** Addresses to try for a node, best first: those that worked, the ones a
 * user pinned in the roster, the ones its LAN beacon showed, then what the
 * node announces. Relay addresses are never candidates. */
export function candidateUrls(
  group: StoredMeshGroup,
  info: MeshNodeInfo | undefined,
  nodeId: string,
  extra: { pinned?: readonly string[]; beacons?: readonly string[] } = {},
): string[] {
  const urls = [...(group.nodeUrls[nodeId] ?? []), ...(extra.pinned ?? []), ...(extra.beacons ?? []), ...(info?.urls ?? [])]
    .filter((url) => meshRelayExpiry(url) === null)
    .map((url) => normalizeServerUrl(url));
  return [...new Set(urls.filter(Boolean))].slice(0, MAX_NODE_URLS);
}

/** `http://<sender>:<port>` of each recent beacon of `nodeId`. */
export function beaconUrls(beacons: readonly MeshBeacon[], nodeId: string): string[] {
  return beacons
    .filter((beacon) => beacon.nodeId === nodeId)
    .sort((a, b) => b.seenAt - a.seenAt)
    .map((beacon) => `http://${beacon.address.includes(':') ? `[${beacon.address}]` : beacon.address}:${beacon.port}`);
}

export type MeshBeacon = { nodeId: string; address: string; port: number; seenAt: number };

/** Records that `url` reached `nodeId`: it moves to the front. */
export function rememberUrl(group: StoredMeshGroup, nodeId: string, url: string): StoredMeshGroup | null {
  if (meshRelayExpiry(url) !== null) return null;
  const normalized = normalizeServerUrl(url);
  const current = group.nodeUrls[nodeId] ?? [];
  if (current[0] === normalized) return null;
  return { ...group, nodeUrls: { ...group.nodeUrls, [nodeId]: [normalized, ...current.filter((item) => item !== normalized)].slice(0, MAX_NODE_URLS) } };
}

export function memberLabel(member: MeshMember): string {
  return member.name || member.id;
}
