const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const mesh = require(path.join(lib, 'mesh.js'));
const paths = require(path.join(lib, 'meshPaths.js'));
const { historyRecipientKeyPairFromSeed } = require(path.join(lib, 'historyCrypto.js'));

const seed = (byte) => new Uint8Array(32).fill(byte);

/** A group with this device, a target node T and relay nodes R1, R2. */
function group(edit = () => {}) {
  const base = mesh.verifyMeshChain(mesh.createMeshGenesis({
    name: 'Home', creatorSecretKey: seed(1), creatorName: 'A',
    creatorHistoryKey: historyRecipientKeyPairFromSeed(seed(1)).publicKey, now: 1, nonce: new Uint8Array(16),
  }));
  const self = base.head.members[0];
  const node = (byte, name) => mesh.meshNodeMember({ publicKey: ed25519.getPublicKey(seed(byte)), name, addedBy: self.id, addedAt: 2 });
  const members = [self, node(7, 'T'), node(8, 'R1'), node(9, 'R2')];
  edit(members);
  const chain = mesh.verifyMeshChain(mesh.appendMeshRoster(base, { signerSecretKey: seed(1), members, now: 2 }));
  const [, target, r1, r2] = chain.head.members;
  return { chain, target, r1, r2 };
}

const ticketFor = (relay) => `dev_x.9.${relay}`;

test('candidates list direct addresses, then relays the roster allows, preferred first', () => {
  const { chain, target, r1, r2 } = group((members) => { members[3] = { ...members[3], relay: 'preferred' }; });
  const candidates = paths.meshPathCandidates({
    chain, targetNodeId: target.id, urls: ['http://10.0.0.7:7345/', 'http://10.0.0.7:7345'],
    relays: [{ nodeId: r1.id, url: 'http://203.0.113.8:7345' }, { nodeId: r2.id, url: 'http://203.0.113.9:7345' }, { nodeId: target.id, url: 'http://x' }],
    relayEnabled: true, ticketFor,
  });
  assert.deepEqual(candidates.map((item) => item.key), ['http://10.0.0.7:7345', `relay:${r2.id}`, `relay:${r1.id}`]);
  assert.equal(candidates[1].via, r2.id);
  assert.equal(candidates[1].url, mesh.meshRelayUrl('http://203.0.113.9:7345', target.id, ticketFor(r2.id)));
});

test('no relay paths when relaying is off, refused by the target, or the relay is denied', () => {
  const relays = (r1, r2) => [{ nodeId: r1.id, url: 'http://203.0.113.8:7345' }, { nodeId: r2.id, url: 'http://203.0.113.9:7345' }];
  const off = group();
  assert.equal(paths.meshPathCandidates({ chain: off.chain, targetNodeId: off.target.id, urls: [], relays: relays(off.r1, off.r2), relayEnabled: false, ticketFor }).length, 0);
  const refused = group((members) => { members[1] = { ...members[1], relayTarget: false }; });
  assert.equal(paths.meshPathCandidates({ chain: refused.chain, targetNodeId: refused.target.id, urls: [], relays: relays(refused.r1, refused.r2), relayEnabled: true, ticketFor }).length, 0);
  const denied = group((members) => { members[2] = { ...members[2], relay: 'denied' }; });
  const left = paths.meshPathCandidates({ chain: denied.chain, targetNodeId: denied.target.id, urls: [], relays: relays(denied.r1, denied.r2), relayEnabled: true, ticketFor });
  assert.deepEqual(left.map((item) => item.via), [denied.r2.id]);
  // A relay only known through another relay is no use.
  const relayed = paths.meshPathCandidates({
    chain: off.chain, targetNodeId: off.target.id, urls: [],
    relays: [{ nodeId: off.r1.id, url: `http://203.0.113.9:7345/v2/mesh/relay/${off.r1.id}/t` }], relayEnabled: true, ticketFor,
  });
  assert.equal(relayed.length, 0);
});

test('a probe times the version call and refuses another node', async () => {
  let clock = 1000;
  const answer = (body, status = 200) => async (url) => {
    assert.equal(url, 'http://10.0.0.7:7345/v2/version');
    clock += 25;
    return new Response(JSON.stringify(body), { status });
  };
  const now = () => clock;
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345/', 'node_t', { fetchImpl: answer({ name: 'todex-agentd', nodeId: 'node_t' }), now }), 25);
  // An older backend without nodeId is taken at its word.
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: answer({ name: 'todex-agentd' }), now }), 25);
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: answer({ name: 'todex-agentd', nodeId: 'node_other' }), now }), null);
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: answer({ name: 'nginx' }), now }), null);
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: answer({}, 502), now }), null);
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: async () => { throw new TypeError('offline'); } }), null);
  // One that never answers fails at the timeout.
  const hanging = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await paths.probeMeshPath('http://10.0.0.7:7345', 'node_t', { fetchImpl: hanging, timeoutMs: 20 }), null);
});

test('a race takes the first path that answers and still reports the rest', async () => {
  const delays = { a: 40, b: 5, c: null };
  const probe = (path) => new Promise((resolve) => setTimeout(() => resolve(delays[path.key]), delays[path.key] ?? 10));
  const seen = [];
  const winner = await paths.raceMeshPaths(['a', 'b', 'c'].map((key) => ({ key, url: key })), probe, (path, ms) => seen.push([path.key, ms]));
  assert.equal(winner.path.key, 'b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen.sort(), [['a', 40], ['b', 5], ['c', null]]);
  assert.equal(await paths.raceMeshPaths([{ key: 'c', url: 'c' }], probe), null);
  assert.equal(await paths.raceMeshPaths([], probe), null);
});

test('a client moves only to a clearly faster path, and not twice within two minutes', () => {
  const samples = (entries) => new Map(Object.entries(entries));
  const pick = (entries, currentKey, now = 1_000_000, lastSwitchAt = 0) => paths.pickMeshPath({ currentKey, samples: samples(entries), now, lastSwitchAt });
  // The median of the last three answers counts; a failed last probe disqualifies.
  assert.equal(paths.meshPathLatency([300, 20, 25]), 25);
  assert.equal(paths.meshPathLatency([20, 25, null]), null);
  assert.deepEqual(paths.addMeshPathSample([1, 2, 3], 4), [2, 3, 4]);
  // Faster by 30% and 40 ms: move.
  assert.equal(pick({ direct: [200, 210, 190], relay: [90, 100, 95] }, 'direct'), 'relay');
  // Faster but by less than 30%: stay.
  assert.equal(pick({ direct: [200, 210, 190], relay: [150, 160, 155] }, 'direct'), null);
  // 30% faster but under 40 ms saved: stay.
  assert.equal(pick({ direct: [50, 50, 50], relay: [20, 20, 20] }, 'direct'), null);
  // Within the cooldown: stay, unless the current path stopped answering.
  assert.equal(pick({ direct: [200, 210, 190], relay: [90, 100, 95] }, 'direct', 1_000_000, 1_000_000 - 60_000), null);
  assert.equal(pick({ direct: [200, 210, null], relay: [90, 100, 95] }, 'direct', 1_000_000, 1_000_000 - 60_000), 'relay');
  // Nothing answers: stay.
  assert.equal(pick({ direct: [null], relay: [null] }, 'direct'), null);
  assert.equal(paths.meshPathKeyOf('http://10.0.0.7:7345/'), 'http://10.0.0.7:7345');
  assert.equal(paths.meshPathKeyOf('http://203.0.113.9:7345/v2/mesh/relay/x/t', 'node_r'), 'relay:node_r');
});
