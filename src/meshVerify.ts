// Mesh verification that remembers its verdicts (shared by every client).
// Verifying a group's roster chain and node infos checks every signature in
// plain-JavaScript ed25519, so a client that asks again for data that has not
// changed (on every render, reachability check, settings page or sync) passes
// through these instead of `meshClient`'s `storedChain` / `nodeInfosOf`,
// which check each time.

import { verifyMeshChain, verifyMeshChainSliced, verifyMeshNodeInfo, type MeshChain, type MeshNodeInfo, type MeshSignedDoc } from './mesh';
import type { MeshVerifiers, StoredMeshGroup } from './meshClient';

/** Verdicts kept by content, oldest dropped first. */
const CHAINS_KEPT = 16;
const INFOS_KEPT = 256;

function remember<V>(map: Map<string, V>, limit: number, key: string, value: V): void {
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

// Bodies and signatures are base64url, so neither separator occurs in them.
const docKey = (doc: MeshSignedDoc) => `${doc.body}\0${doc.sig}`;

export type MeshVerifier = {
  /** `meshClient`'s `storedChain`, remembering each verdict. */
  storedChain: (group: StoredMeshGroup) => MeshChain | null;
  /** `meshClient`'s `nodeInfosOf`, remembering each verdict. */
  nodeInfosOf: (group: StoredMeshGroup, chain: MeshChain) => Map<string, MeshNodeInfo>;
  /** For `mergeNodeState`, which expects a failed check to throw. */
  verifiers: MeshVerifiers;
  /**
   * Verifies a group's chain and its nodes' infos ahead of `storedChain` and
   * `nodeInfosOf`, a document at a time with `pause` between, and keeps the
   * verdicts they then return at once. A client calls it on groups it loads
   * before anything reads them (at start-up, a chain of a few documents held
   * the UI thread for about 250 ms in one go).
   */
  prime: (group: StoredMeshGroup, pause: () => Promise<void>) => Promise<void>;
};

/** `verifyMeshChainSliced`'s shape, for a client that times it. */
export type SlicedChainVerifier = (docs: readonly MeshSignedDoc[], pause: () => Promise<void>) => Promise<MeshChain>;

/**
 * Verdicts are kept by the stored object (stored chains and documents are
 * never edited in place: a change stores new arrays and objects) and by
 * content, since a node's answer to each sync, a freshly parsed copy of the
 * same documents, would otherwise be verified again every time. A verdict
 * depends only on the documents (body and signature) and the key, so content
 * is a sound key; a failed verdict is kept as well.
 */
export function createMeshVerifier(
  verify: MeshVerifiers = { chain: verifyMeshChain, nodeInfo: verifyMeshNodeInfo },
  verifySliced: SlicedChainVerifier = verifyMeshChainSliced,
): MeshVerifier {
  const chainsByDocs = new WeakMap<readonly MeshSignedDoc[], MeshChain | null>();
  const chainsByContent = new Map<string, MeshChain | null>();
  const infosByDoc = new WeakMap<MeshSignedDoc, Map<string, MeshNodeInfo | null>>();
  const infosByContent = new Map<string, MeshNodeInfo | null>();

  function chainOf(docs: readonly MeshSignedDoc[]): MeshChain | null {
    let chain = chainsByDocs.get(docs);
    if (chain !== undefined) return chain;
    const key = docs.map(docKey).join('\n');
    chain = chainsByContent.get(key);
    if (chain === undefined) {
      try {
        chain = verify.chain(docs);
      } catch {
        chain = null;
      }
      remember(chainsByContent, CHAINS_KEPT, key, chain);
    }
    chainsByDocs.set(docs, chain);
    return chain;
  }

  function nodeInfo(doc: MeshSignedDoc, publicKey: string): MeshNodeInfo | null {
    let byKey = infosByDoc.get(doc);
    if (!byKey) {
      byKey = new Map();
      infosByDoc.set(doc, byKey);
    }
    let info = byKey.get(publicKey);
    if (info !== undefined) return info;
    const key = `${publicKey}\0${docKey(doc)}`;
    info = infosByContent.get(key);
    if (info === undefined) {
      try {
        info = verify.nodeInfo(doc, publicKey);
      } catch {
        // A document the roster key does not sign is ignored.
        info = null;
      }
      remember(infosByContent, INFOS_KEPT, key, info);
    }
    byKey.set(publicKey, info);
    return info;
  }

  function storedChain(group: StoredMeshGroup): MeshChain | null {
    if (!group.chain.length) return null;
    const chain = chainOf(group.chain);
    return chain && chain.groupId === group.groupId ? chain : null;
  }

  function nodeInfosOf(group: StoredMeshGroup, chain: MeshChain): Map<string, MeshNodeInfo> {
    const result = new Map<string, MeshNodeInfo>();
    for (const member of chain.head.members) {
      if (member.kind !== 'node') continue;
      const doc = group.nodeInfos[member.id];
      const info = doc ? nodeInfo(doc, member.publicKey) : null;
      if (info) result.set(member.id, info);
    }
    return result;
  }

  const verifiers: MeshVerifiers = {
    chain: (docs) => {
      const chain = chainOf(docs);
      if (!chain) throw new Error('mesh chain does not verify');
      return chain;
    },
    nodeInfo: (doc, publicKey) => {
      const info = nodeInfo(doc, publicKey);
      if (!info) throw new Error('mesh node info does not verify');
      return info;
    },
  };

  async function prime(group: StoredMeshGroup, pause: () => Promise<void>): Promise<void> {
    const docs = group.chain;
    if (!docs.length) return;
    if (chainsByDocs.get(docs) === undefined) {
      const key = docs.map(docKey).join('\n');
      let chain = chainsByContent.get(key);
      if (chain === undefined) {
        try {
          chain = await verifySliced(docs, pause);
        } catch {
          chain = null;
        }
        // Another caller may have settled it meanwhile: the same documents, the same verdict.
        remember(chainsByContent, CHAINS_KEPT, key, chain);
      }
      chainsByDocs.set(docs, chain);
    }
    const chain = storedChain(group);
    if (!chain) return;
    for (const member of chain.head.members) {
      const doc = member.kind === 'node' ? group.nodeInfos[member.id] : undefined;
      if (!doc || infosByDoc.get(doc)?.has(member.publicKey)) continue;
      await pause();
      nodeInfo(doc, member.publicKey);
    }
  }

  return { storedChain, nodeInfosOf, verifiers, prime };
}
