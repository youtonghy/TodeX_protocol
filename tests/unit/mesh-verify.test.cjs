const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const mesh = require(path.join(lib, 'mesh.js'));
const client = require(path.join(lib, 'meshClient.js'));
const { createMeshVerifier } = require(path.join(lib, 'meshVerify.js'));
const { historyRecipientKeyPairFromSeed } = require(path.join(lib, 'historyCrypto.js'));

// Stub verifiers: count the checks a memoizing verifier lets through.
const doc = (body) => ({ body, sig: 'sig' });
const head = {
  type: mesh.MESH_ROSTER_TYPE, v: 1, groupId: 'g1', version: 1, prev: null, name: 'G', signer: 'd', signedAt: 0, recovery: null,
  members: [{ id: 'n1', kind: 'node', name: 'Node', publicKey: 'pk1', addedAt: 0, addedBy: 'd' }],
};
const chain = { groupId: 'g1', docs: [], bodies: [head], head, headHash: new Uint8Array() };
const info = { nodeId: 'n1', publicKey: 'pk1', seq: 1, name: 'Node', transportProtocol: 'none', transportPublicKey: '', urls: ['http://a'], signedAt: 0 };
const group = (over = {}) => ({ groupId: 'g1', name: 'G', chain: [doc('c1')], nodeInfos: { n1: doc('i1') }, nodeUrls: {}, deviceId: 'd', joinedAt: 0, ...over });

function setup() {
  const calls = { chain: 0, nodeInfo: 0 };
  const verifier = createMeshVerifier({
    chain: () => { calls.chain += 1; return chain; },
    nodeInfo: (_doc, publicKey) => {
      calls.nodeInfo += 1;
      if (publicKey !== 'pk1') throw new Error('bad key');
      return info;
    },
  });
  return { calls, verifier };
}

test('verifies a stored chain and its node infos once while they stay the same', () => {
  const { calls, verifier } = setup();
  const stored = group();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(verifier.storedChain(stored), chain);
    assert.equal(verifier.nodeInfosOf(stored, chain).get('n1'), info);
  }
  assert.deepEqual(calls, { chain: 1, nodeInfo: 1 });
});

test('verifies again once the chain or a node info is replaced', () => {
  const { calls, verifier } = setup();
  const stored = group();
  verifier.storedChain(stored);
  verifier.nodeInfosOf(stored, chain);
  const changed = group({ chain: [doc('c1'), doc('c2')], nodeInfos: { n1: doc('i2') } });
  verifier.storedChain(changed);
  verifier.nodeInfosOf(changed, chain);
  assert.deepEqual(calls, { chain: 2, nodeInfo: 2 });
});

test('keeps rejecting what fails verification, an empty chain and another group', () => {
  let attempts = 0;
  const failing = createMeshVerifier({
    chain: () => { attempts += 1; throw new Error('bad signature'); },
    nodeInfo: () => { throw new Error('bad signature'); },
  });
  const stored = group();
  assert.equal(failing.storedChain(stored), null);
  assert.equal(failing.storedChain(stored), null);
  assert.equal(attempts, 1);
  assert.equal(failing.nodeInfosOf(stored, chain).size, 0);
  const { verifier } = setup();
  assert.equal(verifier.storedChain(group({ groupId: 'g2' })), null);
  assert.equal(verifier.storedChain(group({ chain: [] })), null);
});

test('a fresh copy of the same documents (a node answering a sync) is not verified again', () => {
  const { calls, verifier } = setup();
  verifier.storedChain(group());
  verifier.nodeInfosOf(group(), chain);
  const copy = group({ chain: [doc('c1')], nodeInfos: { n1: doc('i1') } });
  assert.equal(verifier.storedChain(copy), chain);
  assert.equal(verifier.verifiers.chain([doc('c1')]), chain);
  assert.equal(verifier.verifiers.nodeInfo(doc('i1'), 'pk1'), info);
  assert.deepEqual(calls, { chain: 1, nodeInfo: 1 });
});

test('the same body under another signature, or for another key, is verified afresh', () => {
  const { calls, verifier } = setup();
  verifier.verifiers.nodeInfo(doc('i1'), 'pk1');
  verifier.verifiers.nodeInfo({ body: 'i1', sig: 'other' }, 'pk1');
  assert.throws(() => verifier.verifiers.nodeInfo(doc('i1'), 'pk2'));
  verifier.verifiers.chain([doc('c1')]);
  verifier.verifiers.chain([{ body: 'c1', sig: 'other' }]);
  assert.deepEqual(calls, { chain: 2, nodeInfo: 3 });
});

test('the merge verifiers throw for what fails, and remember that it failed', () => {
  let attempts = 0;
  const failing = createMeshVerifier({
    chain: () => { attempts += 1; throw new Error('bad signature'); },
    nodeInfo: () => { attempts += 1; throw new Error('bad signature'); },
  });
  for (let i = 0; i < 2; i += 1) {
    assert.throws(() => failing.verifiers.chain([doc('c1')]));
    assert.throws(() => failing.verifiers.nodeInfo({ ...doc('i1') }, 'pk1'));
  }
  assert.equal(attempts, 2);
});

// Real signatures: the memoized verdicts match meshClient's, and a document
// that no longer verifies is caught however it is presented.
const seed = (byte) => new Uint8Array(32).fill(byte);
function realGroup() {
  const base = mesh.verifyMeshChain(mesh.createMeshGenesis({
    name: 'Home', creatorSecretKey: seed(1), creatorName: 'A', creatorHistoryKey: historyRecipientKeyPairFromSeed(seed(1)).publicKey, now: 1, nonce: new Uint8Array(16),
  }));
  const self = base.head.members[0];
  const node = mesh.meshNodeMember({ publicKey: ed25519.getPublicKey(seed(9)), name: 'nas', addedBy: self.id, addedAt: 2 });
  const withNode = mesh.verifyMeshChain(mesh.appendMeshRoster(base, { signerSecretKey: seed(1), members: [self, node], now: 2 }));
  const nodeInfo = mesh.signMeshDoc(mesh.MESH_NODE_INFO_DOMAIN, {
    type: 'todex.mesh.node-info', v: 1, nodeId: node.id, publicKey: node.publicKey, seq: 5, name: 'nas',
    transportProtocol: 'x25519', transportPublicKey: 'AAAA', urls: ['http://10.0.0.9:7345'], signedAt: 5,
  }, seed(9));
  const stored = { groupId: withNode.groupId, name: '', chain: withNode.docs, nodeInfos: { [node.id]: nodeInfo }, nodeUrls: {}, deviceId: self.id, joinedAt: 0 };
  return { base, withNode, node, nodeInfo, stored };
}

test('with real signatures the verdicts match meshClient', () => {
  const { stored, node } = realGroup();
  const verifier = createMeshVerifier();
  const plain = client.storedChain(stored);
  const remembered = verifier.storedChain(stored);
  assert.ok(remembered);
  assert.equal(remembered.groupId, plain.groupId);
  assert.deepEqual(remembered.head, plain.head);
  assert.equal(verifier.storedChain(stored), remembered, 'asked again, the same verdict');
  assert.deepEqual(verifier.nodeInfosOf(stored, remembered).get(node.id), client.nodeInfosOf(stored, plain).get(node.id));
});

test('a tampered signature is rejected even after the untampered chain was verified', () => {
  const { stored } = realGroup();
  const verifier = createMeshVerifier();
  assert.ok(verifier.storedChain(stored));
  const last = stored.chain[stored.chain.length - 1];
  const flipped = `${last.sig.slice(0, -2)}${last.sig.endsWith('AA') ? 'AB' : 'AA'}`;
  const tampered = { ...stored, chain: [...stored.chain.slice(0, -1), { ...last, sig: flipped }] };
  assert.equal(client.storedChain(tampered), null);
  assert.equal(verifier.storedChain(tampered), null);
  const info = Object.values(stored.nodeInfos)[0];
  const chain = verifier.storedChain(stored);
  const badInfo = { ...stored, nodeInfos: { [Object.keys(stored.nodeInfos)[0]]: { ...info, sig: `${info.sig.slice(0, -2)}${info.sig.endsWith('AA') ? 'AB' : 'AA'}` } } };
  assert.equal(verifier.nodeInfosOf(badInfo, chain).size, 0);
});

test('a chain one document shorter or longer gets its own verdict', () => {
  const { stored, base, withNode } = realGroup();
  const verifier = createMeshVerifier();
  assert.equal(verifier.storedChain(stored).head.version, withNode.head.version);
  const shorter = { ...stored, chain: base.docs };
  assert.equal(verifier.storedChain(shorter).head.version, base.head.version);
  const outOfOrder = { ...stored, chain: [...withNode.docs].reverse() };
  assert.equal(verifier.storedChain(outOfOrder), null);
});

test('mergeNodeState gives the same outcome through the remembering verifiers', () => {
  const { stored, withNode, node, nodeInfo } = realGroup();
  const verifier = createMeshVerifier();
  const remote = { nodeId: node.id, nodeInfo, chain: withNode.docs, nodeInfos: [] };
  assert.deepEqual(client.mergeNodeState(stored, remote, verifier.verifiers), client.mergeNodeState(stored, remote));
});

test('the sliced chain check gives verifyMeshChain\'s verdicts, pausing between documents', async () => {
  const { withNode, base } = realGroup();
  let pauses = 0;
  const pause = async () => { pauses += 1; };
  const sliced = await mesh.verifyMeshChainSliced(withNode.docs, pause);
  assert.deepEqual(sliced.head, withNode.head);
  assert.equal(sliced.groupId, withNode.groupId);
  assert.deepEqual(sliced.headHash, withNode.headHash);
  assert.equal(pauses, withNode.docs.length - 1);
  await assert.rejects(mesh.verifyMeshChainSliced([...withNode.docs].reverse(), pause));
  const last = withNode.docs[withNode.docs.length - 1];
  const flipped = { ...last, sig: `${last.sig.slice(0, -2)}${last.sig.endsWith('AA') ? 'AB' : 'AA'}` };
  await assert.rejects(mesh.verifyMeshChainSliced([...withNode.docs.slice(0, -1), flipped], pause), /signature/);
  assert.deepEqual((await mesh.verifyMeshChainSliced(base.docs, pause)).head, base.head);
});

test('priming a group verifies it ahead, so storedChain and nodeInfosOf answer without checking', async () => {
  const { stored, node } = realGroup();
  const calls = { chain: 0, nodeInfo: 0, sliced: 0 };
  const verifier = createMeshVerifier(
    { chain: (docs) => { calls.chain += 1; return mesh.verifyMeshChain(docs); }, nodeInfo: (doc, key) => { calls.nodeInfo += 1; return mesh.verifyMeshNodeInfo(doc, key); } },
    (docs, pause) => { calls.sliced += 1; return mesh.verifyMeshChainSliced(docs, pause); },
  );
  await verifier.prime(stored, async () => undefined);
  assert.deepEqual(calls, { chain: 0, nodeInfo: 1, sliced: 1 });
  const chain = verifier.storedChain(stored);
  assert.ok(chain);
  assert.ok(verifier.nodeInfosOf(stored, chain).get(node.id));
  assert.deepEqual(calls, { chain: 0, nodeInfo: 1, sliced: 1 }, 'answered from the primed verdicts');
  // Primed again: nothing left to check.
  await verifier.prime(stored, async () => undefined);
  assert.deepEqual(calls, { chain: 0, nodeInfo: 1, sliced: 1 });
});

test('a primed chain that does not verify reads as none', async () => {
  const { stored } = realGroup();
  const last = stored.chain[stored.chain.length - 1];
  const tampered = { ...stored, chain: [...stored.chain.slice(0, -1), { ...last, sig: `${last.sig.slice(0, -2)}${last.sig.endsWith('AA') ? 'AB' : 'AA'}` }] };
  const verifier = createMeshVerifier();
  await verifier.prime(tampered, async () => undefined);
  assert.equal(verifier.storedChain(tampered), null);
});
