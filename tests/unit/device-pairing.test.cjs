const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { x25519 } = require('@noble/curves/ed25519.js');
const { xchacha20poly1305 } = require('@noble/ciphers/chacha.js');
const { extract, expand } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  beginDevicePairing,
  fetchBackendDeployment,
  nextPairingPollDelayMs,
  DevicePairingError,
  DevicePairingRetryableError,
} = require(path.join(compiledDir, 'devicePairing.js'));
const { generateDeviceIdentity, encodeBase64Url, decodeBase64Url } = require(path.join(compiledDir, 'deviceAuth.js'));
const {
  DEVICE_PAIRING_V3_WRAP_INFO,
  DEVICE_PAIRING_V3_POLL_INFO,
  devicePairingV3Commitment,
  devicePairingV3Transcript,
} = require(path.join(compiledDir, 'secureChannel.js'));

const SERVER_URL = 'http://192.168.1.20:7345';

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

/** A body-less response, like React Native's fetch, which only offers `arrayBuffer()`. */
function bodyless(response) {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: undefined,
    arrayBuffer: () => response.arrayBuffer(),
  };
}

/**
 * A backend that runs pairing v3 the way `src/device_pairing.rs` does: it
 * checks the commitment on reveal, derives the wrap key from its own secret,
 * and answers `poll` with `steps` (each `pending`, `approved`, `rejected`,
 * an HTTP status, or a function returning a Response).
 */
function fakeBackend({ steps = ['approved'], transport, wrap = (response) => response } = {}) {
  const serverKeys = x25519.keygen();
  const transportKeys = x25519.keygen();
  const transportProtocol = transport?.protocol ?? 'x25519';
  const transportPublicKey = transport?.publicKey ?? encodeBase64Url(transportKeys.publicKey);
  const state = { calls: [], requestId: randomUUID(), steps: [...steps] };
  const fetchImpl = async (url, init) => {
    const action = new URL(url).pathname.split('/').pop();
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push(action);
    assert.equal(init.redirect, 'error');
    if (action === 'version') return wrap(json({ name: 'todex-agentd', deployment: 'container' }));
    if (action === 'create') {
      state.create = body;
      return wrap(json({
        requestId: state.requestId,
        serverPublicKey: encodeBase64Url(serverKeys.publicKey),
        expiresAt: Date.now() + 300_000,
        pollIntervalMs: 1000,
        transportProtocol,
        transportPublicKey,
      }));
    }
    if (action === 'reveal') {
      const clientPublic = decodeBase64Url(body.clientPublicKey);
      const clientNonce = decodeBase64Url(body.clientNonce);
      assert.equal(encodeBase64Url(devicePairingV3Commitment(clientPublic, clientNonce)), state.create.clientCommitment);
      state.transcript = devicePairingV3Transcript({
        requestId: state.requestId,
        clientPublic,
        serverPublic: serverKeys.publicKey,
        devicePublic: decodeBase64Url(state.create.devicePublicKey),
        clientNonce,
        transportProtocol,
        transportPublicKey: decodeBase64Url(transportPublicKey),
        deviceName: state.create.deviceName,
      });
      const shared = x25519.getSharedSecret(serverKeys.secretKey, clientPublic);
      const prk = extract(sha256, shared, sha256(state.transcript));
      state.wrapKey = expand(sha256, prk, new TextEncoder().encode(DEVICE_PAIRING_V3_WRAP_INFO), 32);
      state.pollProof = encodeBase64Url(expand(sha256, prk, new TextEncoder().encode(DEVICE_PAIRING_V3_POLL_INFO), 32));
      return wrap(json({ status: 'pending' }));
    }
    if (action === 'poll') {
      assert.equal(body.proof, state.pollProof);
      const step = state.steps.shift();
      if (typeof step === 'function') return step();
      if (typeof step === 'number') return new Response('', { status: step, headers: { 'Retry-After': '3' } });
      if (step !== 'approved') return wrap(json({ status: step }));
      const deviceId = state.deviceId ?? `dev_${createHash('sha256').update(decodeBase64Url(state.create.devicePublicKey)).digest().subarray(0, 12).toString('base64url')}`;
      const nonce = new Uint8Array(24).fill(7);
      const plaintext = new TextEncoder().encode(JSON.stringify({
        deviceId,
        transportProtocol: state.credentialProtocol ?? transportProtocol,
        transportPublicKey,
      }));
      const ciphertext = xchacha20poly1305(state.wrapKey, nonce, state.transcript).encrypt(plaintext);
      return wrap(json({ status: 'approved', nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(ciphertext) }));
    }
    if (action === 'cancel') return wrap(json({ status: 'cancelled' }));
    throw new Error(`unexpected ${action}`);
  };
  return { fetchImpl, state };
}

test('pairs end to end and returns the verified transport pin', async () => {
  const device = generateDeviceIdentity();
  const backend = fakeBackend({ steps: ['pending', 'approved'] });
  const request = await beginDevicePairing(SERVER_URL, '  Pixel 9  ', device, undefined, { fetchImpl: backend.fetchImpl });
  assert.match(request.verificationCode, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  assert.match(request.transportFingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(request.pollIntervalMs, 1000);
  assert.equal(backend.state.create.deviceName, 'Pixel 9');
  assert.deepEqual(await request.poll(), { status: 'pending' });
  const result = await request.poll();
  assert.equal(result.status, 'approved');
  assert.equal(result.deviceId, device.deviceId);
  assert.equal(result.pin.encryptionProtocol, 'x25519');
  assert.deepEqual(backend.state.calls, ['create', 'reveal', 'poll', 'poll']);
  // The request is finished: later polls report expiry without a call.
  assert.deepEqual(await request.poll(), { status: 'expired' });
  assert.equal(backend.state.calls.length, 4);
});

test('works with a fetch that exposes no body stream (React Native)', async () => {
  const backend = fakeBackend({ wrap: bodyless });
  const request = await beginDevicePairing(SERVER_URL, 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: backend.fetchImpl });
  assert.equal((await request.poll()).status, 'approved');
  assert.equal(await fetchBackendDeployment(SERVER_URL, undefined, { fetchImpl: backend.fetchImpl }), 'container');
});

test('errors carry a code and the message the client supplies', async () => {
  const backend = fakeBackend({ transport: { protocol: 'none', publicKey: '' } });
  const message = (code, params) => `msg:${code}:${params.status ?? ''}`;
  await assert.rejects(
    beginDevicePairing(SERVER_URL, 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: backend.fetchImpl, message }),
    (error) => error instanceof DevicePairingError && error.code === 'encryptionRequired' && error.message === 'msg:encryptionRequired:',
  );
  await assert.rejects(
    beginDevicePairing('http://[bad', 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: backend.fetchImpl }),
    (error) => error.code === 'invalidUrl' && error.message === 'invalidUrl',
  );
});

test('transient poll failures are retryable; a credential for another device pins nothing', async () => {
  const backend = fakeBackend({ steps: [429, 503, 'approved'] });
  const request = await beginDevicePairing(SERVER_URL, 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: backend.fetchImpl });
  await assert.rejects(request.poll(), (error) => {
    assert.ok(error instanceof DevicePairingRetryableError);
    assert.equal(error.code, 'tooMany');
    assert.equal(nextPairingPollDelayMs(1000, error), 3000);
    return true;
  });
  await assert.rejects(request.poll(), (error) => error instanceof DevicePairingRetryableError && error.code === 'http' && error.status === 503);
  backend.state.deviceId = 'dev_AAAAAAAAAAAAAAAA';
  await assert.rejects(request.poll(), (error) => error.code === 'transportMismatch');
});

test('a rejected request ends; cancel withdraws it once', async () => {
  const backend = fakeBackend({ steps: ['rejected'] });
  const request = await beginDevicePairing(SERVER_URL, 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: backend.fetchImpl });
  assert.deepEqual(await request.poll(), { status: 'rejected' });
  await request.cancel();
  assert.ok(!backend.state.calls.includes('cancel'));

  const pending = fakeBackend();
  const second = await beginDevicePairing(SERVER_URL, 'Phone', generateDeviceIdentity(), undefined, { fetchImpl: pending.fetchImpl });
  await second.cancel();
  await second.cancel();
  assert.equal(pending.state.calls.filter((call) => call === 'cancel').length, 1);
});
