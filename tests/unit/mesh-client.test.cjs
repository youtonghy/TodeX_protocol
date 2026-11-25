const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const mesh = require(path.join(lib, 'mesh.js'));
const client = require(path.join(lib, 'meshClient.js'));
const { historyRecipientKeyPairFromSeed } = require(path.join(lib, 'historyCrypto.js'));

const seed = (byte) => new Uint8Array(32).fill(byte);
const history = (byte) => historyRecipientKeyPairFromSeed(seed(byte)).publicKey;

function group() {
  const base = mesh.verifyMeshChain(mesh.createMeshGenesis({ name: 'Home', creatorSecretKey: seed(1), creatorName: 'A', creatorHistoryKey: history(1), now: 1, nonce: new Uint8Array(16) }));
  const self = base.head.members[0];
  const node = mesh.meshNodeMember({ publicKey: ed25519.getPublicKey(seed(9)), name: 'nas', addedBy: self.id, addedAt: 2 });
  const withNode = mesh.verifyMeshChain(mesh.appendMeshRoster(base, { signerSecretKey: seed(1), members: [self, node], now: 2 }));
  const info = mesh.signMeshDoc(mesh.MESH_NODE_INFO_DOMAIN, {
    type: 'todex.mesh.node-info', v: 1, nodeId: node.id, publicKey: node.publicKey, seq: 5, name: 'nas',
    transportProtocol: 'x25519', transportPublicKey: 'AAAA', urls: ['http://10.0.0.9:7345'], signedAt: 5,
  }, seed(9));
  return { base, withNode, self, node, info };
}

const stored = (chain, deviceId, extra = {}) => ({ groupId: chain.groupId, name: '', chain: chain.docs, nodeInfos: {}, nodeUrls: {}, deviceId, joinedAt: 0, ...extra });

test('a device without a roster adopts one that lists it, and only that', () => {
  const { withNode, self, node, info } = group();
  const empty = stored(withNode, self.id, { chain: [] });
  const adopted = client.mergeNodeState(empty, { nodeId: node.id, nodeInfo: info, chain: withNode.docs, nodeInfos: [] });
  assert.equal(adopted.changed, true);
  assert.equal(adopted.group.chain.length, 2);
  assert.ok(adopted.group.nodeInfos[node.id], 'the node info is kept');
  const stranger = client.mergeNodeState({ ...empty, deviceId: 'dev_AAAAAAAAAAAAAAAA' }, { nodeId: node.id, nodeInfo: info, chain: withNode.docs });
  assert.equal(stranger.group.chain.length, 0);
});

test('the newer roster wins either way; a node that is behind gets a push', () => {
  const { base, withNode, self, node, info } = group();
  const behind = client.mergeNodeState(stored(withNode, self.id), { nodeId: node.id, nodeInfo: info, chain: base.docs });
  assert.equal(behind.push, true);
  assert.equal(behind.group.chain.length, 2);
  const ahead = client.mergeNodeState(stored(base, self.id), { nodeId: node.id, nodeInfo: info, chain: withNode.docs });
  assert.equal(ahead.group.chain.length, 2);
  assert.equal(ahead.push, false);
});

test('a roster without this device means it was removed', () => {
  const { withNode, self, node, info } = group();
  const other = mesh.meshDeviceMember({ publicKey: ed25519.getPublicKey(seed(2)), name: 'B', historyKey: history(2), addedBy: self.id });
  const both = mesh.verifyMeshChain(mesh.appendMeshRoster(withNode, { signerSecretKey: seed(1), members: [self, node, other] }));
  const without = mesh.verifyMeshChain(mesh.appendMeshRoster(both, { signerSecretKey: seed(1), members: [self, node] }));
  const outcome = client.mergeNodeState(stored(both, other.id), { nodeId: node.id, nodeInfo: info, chain: without.docs });
  assert.equal(outcome.removed, true);
});

test('addresses: what worked, pinned, beacons, announced; never a relay address', () => {
  const { withNode, self, node, info } = group();
  const g = stored(withNode, self.id, { nodeUrls: { [node.id]: ['http://192.168.1.5:7345'] } });
  const parsed = mesh.verifyMeshNodeInfo(info, node.publicKey);
  const relay = mesh.meshRelayUrl('http://10.0.0.2:7345', node.id, `${self.id}.99.x`);
  const urls = client.candidateUrls(g, parsed, node.id, {
    pinned: ['https://nas.example.net:7345', relay],
    beacons: client.beaconUrls([{ nodeId: node.id, address: '192.168.1.7', port: 7345, seenAt: 1 }], node.id),
  });
  assert.deepEqual(urls, ['http://192.168.1.5:7345', 'https://nas.example.net:7345', 'http://192.168.1.7:7345', 'http://10.0.0.9:7345']);
  assert.equal(client.rememberUrl(g, node.id, relay), null);
  assert.deepEqual(client.rememberUrl(g, node.id, 'http://10.0.0.9:7345').nodeUrls[node.id], ['http://10.0.0.9:7345', 'http://192.168.1.5:7345']);
  assert.deepEqual(client.normalizeStoredMeshGroups([null, { groupId: 1 }, g]).length, 1);
});

test('loopback addresses are candidates only when this device stored them', () => {
  const { withNode, self, node, info } = group();
  const parsed = mesh.verifyMeshNodeInfo(info, node.publicKey);
  // A tunnel's local end this device connected through stays a candidate.
  const own = stored(withNode, self.id, { nodeUrls: { [node.id]: ['http://127.0.0.1:7345'] } });
  assert.deepEqual(client.candidateUrls(own, parsed, node.id), ['http://127.0.0.1:7345', 'http://10.0.0.9:7345']);
  // One another device pinned, or the node announced, names this machine.
  const shared = client.candidateUrls(stored(withNode, self.id), { ...parsed, urls: ['http://localhost:7345', ...parsed.urls] }, node.id, {
    pinned: ['http://127.0.0.1:7345', 'http://[::1]:7345', 'http://203.0.113.7:7345'],
  });
  assert.deepEqual(shared, ['http://203.0.113.7:7345', 'http://10.0.0.9:7345']);
  assert.ok(mesh.isShareableMeshAddress('http://203.0.113.7:7345'));
  assert.ok(!mesh.isShareableMeshAddress('http://127.0.0.1:7345'));
  assert.ok(!mesh.isShareableMeshAddress('http://localhost:7345'));
  assert.ok(!mesh.isShareableMeshAddress('ftp://x'));
  // Roster validation is unchanged: a chain that pins one still verifies.
  assert.ok(mesh.isMeshAddress('http://127.0.0.1:7345'));
});

test('a leave is delivered once every node, or with other devices any node, confirms it', () => {
  const nodes = [{ id: 'n1', name: 'nas' }, { id: 'n2', name: 'mini' }];
  const dissolve = client.startLeave(nodes, false, new Set(['n1']), 7);
  assert.deepEqual(dissolve, { at: 7, othersCarry: false, nodeCount: 2, pendingNodes: ['n2'], nodeNames: { n1: 'nas', n2: 'mini' } });
  assert.equal(client.leaveDelivered(dissolve), false);
  assert.equal(client.leaveDelivered(client.confirmLeave(dissolve, 'n2')), true);
  // Other devices carry the roster on: one node is enough.
  const leave = client.startLeave(nodes, true, new Set(), 7);
  assert.equal(client.leaveDelivered(leave), false);
  assert.equal(client.leaveDelivered(client.confirmLeave(leave, 'n2')), true);
  // A group without nodes has nothing to deliver.
  assert.equal(client.leaveDelivered(client.startLeave([], false, new Set())), true);
});

test('a stored leave survives a reload and a malformed one is dropped', () => {
  const { withNode, self } = group();
  const leaving = { at: 3, othersCarry: false, nodeCount: 1, pendingNodes: ['n'], nodeNames: { n: 'nas' } };
  const [kept] = client.normalizeStoredMeshGroups([stored(withNode, self.id, { leaving })]);
  assert.deepEqual(kept.leaving, leaving);
  const [dropped] = client.normalizeStoredMeshGroups([stored(withNode, self.id, { leaving: { at: 'x' } })]);
  assert.equal('leaving' in dropped, false);
});

function countingVerifiers() {
  const calls = { chain: 0, nodeInfo: 0 };
  return {
    calls,
    verify: {
      chain: (docs) => { calls.chain += 1; return mesh.verifyMeshChain(docs); },
      nodeInfo: (doc, publicKey) => { calls.nodeInfo += 1; return mesh.verifyMeshNodeInfo(doc, publicKey); },
    },
  };
}

test('a merge verifies through the verifiers it is given, with the same outcome', () => {
  const { withNode, self, node, info } = group();
  const { calls, verify } = countingVerifiers();
  const remote = { nodeId: node.id, nodeInfo: info, chain: withNode.docs, nodeInfos: [] };
  const counted = client.mergeNodeState(stored(withNode, self.id), remote, verify);
  const plain = client.mergeNodeState(stored(withNode, self.id), remote);
  assert.deepEqual(counted, plain);
  assert.equal(calls.chain, 2, 'the stored chain and the remote one');
  assert.ok(calls.nodeInfo >= 1);
  assert.equal(counted.group.nodeInfos[node.id], info);
});

test('node info already stored as it is is not verified again', () => {
  const { withNode, self, node, info } = group();
  const { calls, verify } = countingVerifiers();
  const synced = stored(withNode, self.id, { nodeInfos: { [node.id]: info } });
  const outcome = client.mergeNodeState(synced, { nodeId: node.id, nodeInfo: { ...info }, chain: withNode.docs, nodeInfos: [{ ...info }] }, verify);
  assert.equal(calls.nodeInfo, 0);
  assert.equal(outcome.changed, false);
  // Same body, other signature: verified (and rejected).
  const forged = { body: info.body, sig: mesh.signMeshDoc(mesh.MESH_NODE_INFO_DOMAIN, { x: 1 }, seed(9)).sig };
  const again = client.mergeNodeState(synced, { nodeId: node.id, nodeInfo: forged, chain: withNode.docs }, verify);
  assert.ok(calls.nodeInfo > 0);
  assert.equal(again.group.nodeInfos[node.id], info);
});
