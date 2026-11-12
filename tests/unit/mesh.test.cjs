const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const mesh = require(path.join(lib, 'mesh.js'));
const { historyRecipientKeyPairFromSeed } = require(path.join(lib, 'historyCrypto.js'));
const { decodeBase64Url } = require(path.join(lib, 'deviceAuth.js'));
const fixture = require('../fixtures/mesh-v1.json');

const hexBytes = (value) => new Uint8Array(Buffer.from(value, 'hex'));

test('the fixture chain verifies to its group, versions and members', () => {
  const chain = mesh.verifyMeshChain(fixture.chain);
  assert.equal(chain.groupId, fixture.groupId);
  assert.equal(mesh.meshChainHead(chain), fixture.versions.at(-1).head);
  fixture.versions.forEach((expected, index) => {
    const prefix = mesh.verifyMeshChain(fixture.chain.slice(0, index + 1));
    assert.equal(mesh.meshChainHead(prefix), expected.head);
    assert.deepEqual(prefix.head.members.map((member) => member.id), expected.members);
  });
  assert.equal(chain.head.signer, 'recovery');
});

test('invalid chains are refused', () => {
  for (const [name, docs] of Object.entries(fixture.invalidChains)) {
    assert.throws(() => mesh.verifyMeshChain(docs), mesh.MeshError, name);
  }
});

test('the recovery seed derives the roster recovery keys', () => {
  const { recovery } = mesh.meshRecoveryKeys(hexBytes(fixture.recovery.seed));
  assert.equal(recovery.signingKey, fixture.recovery.signingKey);
  assert.equal(recovery.historyKey, fixture.recovery.historyKey);
});

test('node info verifies only against its roster key', () => {
  const info = mesh.verifyMeshNodeInfo(fixture.nodeInfo.doc, fixture.nodeInfo.publicKey);
  assert.equal(info.nodeId, fixture.memberIds.node);
  assert.deepEqual(info.urls, fixture.nodeInfo.body.urls);
  assert.throws(() => mesh.verifyMeshNodeInfo(fixture.nodeInfo.doc, fixture.historyKeyBinding.devicePublicKey));
});

test('the history key binding and the join code proofs match the vectors', () => {
  const binding = fixture.historyKeyBinding;
  assert.ok(mesh.verifyMeshHistoryKeySignature(
    decodeBase64Url(binding.devicePublicKey), binding.groupId, decodeBase64Url(binding.historyKey), binding.signature,
  ));
  assert.ok(!mesh.verifyMeshHistoryKeySignature(
    decodeBase64Url(binding.devicePublicKey), 'grp_other', decodeBase64Url(binding.historyKey), binding.signature,
  ));
  const code = fixture.joinCode;
  assert.equal(mesh.normalizeMeshJoinCode(code.code), code.normalized);
  assert.ok(mesh.isMeshJoinCode(code.code));
  const key = mesh.meshJoinCodeKey(code.code);
  assert.equal(Buffer.from(key).toString('hex'), code.codeKey);
  assert.equal(mesh.meshNodeJoinClientProof(key, hexBytes(code.transcriptHash)), code.clientProof);
  assert.equal(mesh.meshNodeJoinServerProof(key, hexBytes(code.transcriptHash), decodeBase64Url(code.nodePublicKey)), code.serverProof);
});

test('editing a chain: members add, remove, and the fork rule picks one head', () => {
  const secret = (byte) => new Uint8Array(32).fill(byte);
  const history = (byte) => historyRecipientKeyPairFromSeed(new Uint8Array(32).fill(byte)).publicKey;
  const genesis = mesh.createMeshGenesis({ name: 'Lab', creatorSecretKey: secret(1), creatorName: 'A', creatorHistoryKey: history(1) });
  const base = mesh.verifyMeshChain(genesis);
  const b = mesh.meshDeviceMember({ publicKey: ed25519.getPublicKey(secret(2)), name: 'B', historyKey: history(2), addedBy: base.head.members[0].id });
  const left = mesh.verifyMeshChain(mesh.appendMeshRoster(base, { signerSecretKey: secret(1), members: [...base.head.members, b] }));
  const right = mesh.verifyMeshChain(mesh.appendMeshRoster(base, { signerSecretKey: secret(1), name: 'Lab 2' }));
  assert.notEqual(mesh.meshChainWins(left, right), mesh.meshChainWins(right, left));
  assert.ok(mesh.meshChainWins(left, base));
  // A device the head does not list cannot sign.
  assert.throws(() => mesh.appendMeshRoster(base, { signerSecretKey: secret(2) }), mesh.MeshError);
  // Removing the last device is refused.
  assert.throws(() => mesh.appendMeshRoster(base, { signerSecretKey: secret(1), members: [] }), mesh.MeshError);
});

test('invites carry only addresses and parse strictly', () => {
  const text = mesh.encodeMeshInvite({ groupId: fixture.groupId, name: 'Home', nodes: [{ nodeId: fixture.memberIds.node, name: 'nas', urls: ['http://192.168.1.20:7345', 'ftp://x'] }] });
  const invite = mesh.parseMeshInvite(text);
  assert.equal(invite.groupId, fixture.groupId);
  assert.deepEqual(invite.nodes[0].urls, ['http://192.168.1.20:7345']);
  assert.throws(() => mesh.parseMeshInvite('{"kind":"todex-pairing-link"}'), mesh.MeshError);
  assert.throws(() => mesh.parseMeshInvite(mesh.encodeMeshInvite({ groupId: fixture.groupId, name: 'x', nodes: [] })), mesh.MeshError);
});

test('approving a join request checks its keys', () => {
  const chain = mesh.verifyMeshChain(fixture.chain);
  const second = chain.head.members.find((member) => member.kind === 'device');
  const request = {
    requestId: 'r', groupId: chain.groupId, verificationCode: 'X', deviceName: 'New', deviceId: second.id,
    devicePublicKey: second.publicKey, historyKey: second.historyKey, peerAddress: '', expiresAt: 0,
  };
  assert.equal(mesh.meshMemberForJoinRequest(request, 'dev_x').id, second.id);
  assert.throws(() => mesh.meshMemberForJoinRequest({ ...request, deviceId: fixture.memberIds.creator }, 'dev_x'), mesh.MeshError);
});
