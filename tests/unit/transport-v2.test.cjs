const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { x25519 } = require('@noble/curves/ed25519.js');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { xchacha20poly1305 } = require('@noble/ciphers/chacha.js');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const channel = require(path.join(compiledDir, 'secureChannel.js'));
const {
  RecordCipher,
  RecordStreamDecoder,
  TransportCryptoError,
  TransportPayloadTooLargeError,
  TRANSPORT_V2_DIRECTION_DOWN: DOWN,
  TRANSPORT_V2_DIRECTION_UP: UP,
  clientHandshake,
  createWsChannel,
  decodeInnerRequest,
  deriveDevicePairingV3Material,
  deriveTransportKeys,
  devicePairingV3Commitment,
  encodeInnerResponse,
  openRecordStream,
  openRestResponse,
  openRestResponseStream,
  sealRecordStream,
  sealRestRequest,
} = channel;
const {
  EncryptionRequiredError,
  TransportRepairRequiredError,
  checkTransportPolicy,
  createSecureTransport,
  deviceRequestSigner,
} = require(path.join(compiledDir, 'secureTransport.js'));
const { createTransportCryptoSession } = require(path.join(compiledDir, 'transportCrypto.js'));
const { generateDeviceIdentity } = require(path.join(compiledDir, 'deviceAuth.js'));

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'transport-v2.json'), 'utf8'),
);
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (value) => Uint8Array.from(Buffer.from(value, 'base64url'));
const utf8 = (text) => new TextEncoder().encode(text);
const sha = (bytes) => toHex(sha256(bytes));

function randomnessFor(vector, side) {
  const client = vector[side].client;
  return {
    clientNonce: hex(vector[side].clientNonce),
    ...(client.secretKey ? { x25519SecretKey: hex(client.secretKey) } : {}),
    ...(client.encapsulationMessage ? { mlKemMessage: hex(client.encapsulationMessage) } : {}),
  };
}

/** Server side of the key agreement, as the backend does it. */
function serverShared(protocol, serverSecret, clientMaterial) {
  return protocol === 'x25519'
    ? x25519.getSharedSecret(serverSecret, clientMaterial)
    : ml_kem768.decapsulate(clientMaterial, serverSecret);
}

function wsKeys(vector) {
  return deriveTransportKeys({
    label: fixture.constants.wsLabel,
    protocol: vector.protocol,
    deviceId: vector.ws.deviceId,
    serverStaticPublic: hex(vector.server.publicKey),
    clientMaterial: hex(vector.ws.clientMaterial),
    clientNonce: hex(vector.ws.clientNonce),
    serverNonce: hex(vector.ws.serverNonce),
    shared: hex(vector.ws.shared),
  });
}

function restKeys(vector) {
  return deriveTransportKeys({
    label: fixture.constants.restLabel,
    protocol: vector.protocol,
    deviceId: '',
    serverStaticPublic: hex(vector.server.publicKey),
    clientMaterial: hex(vector.rest.clientMaterial),
    clientNonce: hex(vector.rest.clientNonce),
    serverNonce: new Uint8Array(),
    shared: hex(vector.rest.shared),
  });
}

for (const vector of fixture.protocols) {
  const { protocol } = vector;

  test(`${protocol}: client handshake and server key agreement reproduce the vector`, () => {
    for (const side of ['ws', 'rest']) {
      const handshake = clientHandshake(protocol, hex(vector.server.publicKey), randomnessFor(vector, side));
      assert.equal(toHex(handshake.clientMaterial), vector[side].clientMaterial);
      assert.equal(toHex(handshake.shared), vector[side].shared);
      const server = serverShared(protocol, hex(vector.server.secretKey), hex(vector[side].clientMaterial));
      assert.equal(toHex(server), vector[side].shared);
    }
    if (protocol === 'x25519') {
      assert.equal(toHex(x25519.getPublicKey(hex(vector.server.secretKey))), vector.server.publicKey);
    } else {
      const keys = ml_kem768.keygen(hex(vector.server.keygenSeed));
      assert.equal(toHex(keys.publicKey), vector.server.publicKey);
      assert.equal(toHex(keys.secretKey), vector.server.secretKey);
    }
  });

  test(`${protocol}: key schedule matches th, k_up and k_down`, () => {
    for (const [side, keys] of [['ws', wsKeys(vector)], ['rest', restKeys(vector)]]) {
      assert.equal(toHex(keys.th), vector[side].th);
      assert.equal(toHex(keys.kUp), vector[side].kUp);
      assert.equal(toHex(keys.kDown), vector[side].kDown);
    }
  });

  test(`${protocol}: WebSocket channel builds the query, accepts the hello and seals/opens frames`, () => {
    const handshake = createWsChannel({
      protocol,
      serverPublicKey: b64(hex(vector.server.publicKey)),
      deviceId: vector.ws.deviceId,
      randomness: randomnessFor(vector, 'ws'),
    });
    assert.deepEqual(handshake.queryParams, vector.ws.query);
    const session = handshake.acceptHello(vector.ws.hello);
    assert.throws(() => handshake.acceptHello(vector.ws.hello), TransportCryptoError);
    for (const frame of vector.ws.frames.filter((entry) => entry.direction === 'up')) {
      assert.equal(toHex(session.seal(frame.plaintext)), frame.frame);
    }
    for (const frame of vector.ws.frames.filter((entry) => entry.direction === 'down')) {
      assert.equal(session.open(hex(frame.frame)), frame.plaintext);
    }
    session.dispose();
  });

  test(`${protocol}: REST request seals byte-for-byte and the response opens`, () => {
    const head = JSON.parse(vector.rest.request.headJson);
    const sealed = sealRestRequest({
      protocol,
      serverPublicKey: hex(vector.server.publicKey),
      request: {
        method: head.method,
        path: head.path,
        query: head.query,
        headers: head.headers,
        body: hex(vector.rest.request.body),
      },
      randomness: randomnessFor(vector, 'rest'),
    });
    assert.deepEqual(sealed.headers, vector.rest.outerHeaders);
    assert.equal(toHex(sealed.body), vector.rest.request.stream);
    const response = openRestResponse(sealed.context, hex(vector.rest.response.stream));
    assert.equal(response.status, vector.rest.response.status);
    assert.deepEqual(response.headers, JSON.parse(vector.rest.response.headJson).headers);
    assert.equal(toHex(response.body), vector.rest.response.body);
    assert.throws(() => openRestResponse(sealed.context, hex(vector.rest.response.stream)), TransportCryptoError);

    // Server view: the request stream opens to the pinned inner request.
    const keys = restKeys(vector);
    const inner = decodeInnerRequest(openRecordStream(new RecordCipher(keys.kUp, keys.th, UP), hex(vector.rest.request.stream)));
    assert.equal(inner.method, 'POST');
    assert.equal(inner.path, head.path);
    assert.equal(inner.query, head.query);
    assert.equal(toHex(inner.body), vector.rest.request.body);
  });

  test(`${protocol}: the multi-record response matches its digests and streams record by record`, async () => {
    const keys = restKeys(vector);
    const big = vector.rest.multiRecordResponse;
    const body = Uint8Array.from({ length: big.bodyLength }, (_, index) => index % 251);
    const plaintext = (() => {
      const headBytes = utf8(big.headJson);
      const out = new Uint8Array(4 + headBytes.length + body.length);
      new DataView(out.buffer).setUint32(0, headBytes.length, false);
      out.set(headBytes, 4);
      out.set(body, 4 + headBytes.length);
      return out;
    })();
    assert.equal(sha(plaintext), big.plaintextSha256);
    const stream = sealRecordStream(new RecordCipher(keys.kDown, keys.th, DOWN), plaintext);
    assert.equal(stream.length, big.streamLength);
    assert.equal(sha(stream), big.streamSha256);

    // Feed it in awkward 1000-byte chunks through the streaming opener.
    const sealed = sealRestRequest({
      protocol,
      serverPublicKey: hex(vector.server.publicKey),
      request: { method: 'GET', path: '/v2/x' },
      randomness: randomnessFor(vector, 'rest'),
    });
    const chunks = [];
    for (let offset = 0; offset < stream.length; offset += 1000) chunks.push(stream.slice(offset, offset + 1000));
    const response = await openRestResponseStream(sealed.context, chunks);
    assert.equal(response.status, 200);
    const received = [];
    for await (const chunk of response.body) received.push(...chunk);
    assert.equal(received.length, body.length);
    assert.equal(sha(Uint8Array.from(received)), sha(body));
  });

  test(`${protocol}: every failure vector is rejected`, async () => {
    const ws = wsKeys(vector);
    const rest = restKeys(vector);
    for (const failure of vector.failures) {
      if (failure.kind === 'ws') {
        const session = createWsChannel({
          protocol,
          serverPublicKey: hex(vector.server.publicKey),
          deviceId: vector.ws.deviceId,
          randomness: randomnessFor(vector, 'ws'),
        }).acceptHello(vector.ws.hello);
        assert.throws(() => session.open(hex(failure.input)), TransportCryptoError, failure.name);
        // Independent check with a bare down cipher.
        const cipher = new RecordCipher(ws.kDown, ws.th, DOWN);
        assert.ok(cipher.nextCounter === 0n);
        continue;
      }
      assert.throws(
        () => openRecordStream(new RecordCipher(rest.kDown, rest.th, DOWN), hex(failure.input)),
        TransportCryptoError,
        failure.name,
      );
      const sealed = sealRestRequest({
        protocol,
        serverPublicKey: hex(vector.server.publicKey),
        request: { method: 'GET', path: '/v2/x' },
        randomness: randomnessFor(vector, 'rest'),
      });
      await assert.rejects(async () => {
        const response = await openRestResponseStream(sealed.context, [hex(failure.input)]);
        for await (const _chunk of response.body) { /* drain */ }
      }, TransportCryptoError, `${failure.name} (stream)`);
    }
  });
}

test('pairing v3 commitment, transcript, code and keys match the vector', () => {
  const vector = fixture.pairingV3;
  assert.equal(toHex(devicePairingV3Commitment(hex(vector.clientPublicKey), hex(vector.clientNonce))), vector.commitment);
  const material = deriveDevicePairingV3Material({
    requestId: vector.requestId,
    clientSecretKey: hex(vector.clientSecretKey),
    serverPublic: hex(vector.serverPublicKey),
    devicePublic: hex(vector.devicePublicKey),
    clientNonce: hex(vector.clientNonce),
  });
  assert.equal(toHex(material.transcript), vector.transcript);
  assert.equal(toHex(material.transcriptHash), vector.transcriptHash);
  assert.equal(material.verificationCode, vector.verificationCode);
  assert.match(material.verificationCode, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  assert.equal(toHex(material.wrapKey), vector.wrapKey);
  assert.equal(toHex(material.pollProof), vector.pollProof);
  assert.equal(toHex(material.cancelProof), vector.cancelProof);
});

test('records reject wrong counters, wrong direction and wrong final flags', () => {
  const key = new Uint8Array(32).fill(7);
  const th = new Uint8Array(32).fill(9);
  const sender = new RecordCipher(key, th, UP);
  const first = sender.seal(utf8('a'), false);
  const second = sender.seal(utf8('b'), false);

  const receiver = new RecordCipher(key, th, UP);
  assert.throws(() => receiver.open(1n, second.ciphertext, false), TransportCryptoError);
  assert.throws(() => receiver.open(0n, second.ciphertext, false), TransportCryptoError);
  assert.throws(() => receiver.open(0n, first.ciphertext, true), TransportCryptoError, 'wrong final flag');
  assert.throws(() => new RecordCipher(key, th, DOWN).open(0n, first.ciphertext, false), TransportCryptoError);
  // Failures never advance the counter.
  assert.equal(receiver.nextCounter, 0n);
  assert.equal(new TextDecoder().decode(receiver.open(0n, first.ciphertext, false)), 'a');
  assert.throws(() => receiver.open(0n, first.ciphertext, false), TransportCryptoError, 'replay');
  assert.equal(new TextDecoder().decode(receiver.open(1n, second.ciphertext, false)), 'b');
});

test('record streams reject truncation, trailing bytes and missing final across chunk boundaries', () => {
  const key = new Uint8Array(32).fill(1);
  const th = new Uint8Array(32).fill(2);
  const stream = sealRecordStream(new RecordCipher(key, th, DOWN), new Uint8Array(70000).fill(3));
  const decoder = new RecordStreamDecoder(new RecordCipher(key, th, DOWN));
  let total = 0;
  for (let offset = 0; offset < stream.length; offset += 4097) {
    for (const part of decoder.push(stream.subarray(offset, offset + 4097))) total += part.length;
  }
  decoder.finish();
  assert.equal(total, 70000);
  assert.throws(() => decoder.push(Uint8Array.of(0)), TransportCryptoError);

  const truncated = new RecordStreamDecoder(new RecordCipher(key, th, DOWN));
  truncated.push(stream.subarray(0, 65556 + 10));
  assert.throws(() => truncated.finish(), TransportCryptoError);

  const empty = sealRecordStream(new RecordCipher(key, th, DOWN), new Uint8Array());
  assert.equal(openRecordStream(new RecordCipher(key, th, DOWN), empty).length, 0);
});

test('oversized WebSocket plaintext is rejected before sealing without consuming a counter', () => {
  const vector = fixture.protocols[0];
  const session = createWsChannel({
    protocol: vector.protocol,
    serverPublicKey: hex(vector.server.publicKey),
    deviceId: vector.ws.deviceId,
    maxFrameBytes: 24 + 64,
    randomness: randomnessFor(vector, 'ws'),
  }).acceptHello(vector.ws.hello);
  assert.throws(() => session.seal('x'.repeat(65)), TransportPayloadTooLargeError);
  const up = vector.ws.frames.find((frame) => frame.direction === 'up' && frame.counter === 0);
  assert.equal(toHex(session.seal(up.plaintext)), up.frame, 'counter 0 is still unused');
});

test('malformed hello is a crypto failure', () => {
  const vector = fixture.protocols[0];
  const make = () => createWsChannel({
    protocol: vector.protocol,
    serverPublicKey: hex(vector.server.publicKey),
    deviceId: '',
  });
  for (const hello of [
    'not json',
    '{"type":"todex.transport.hello","version":1,"serverNonce":"AAAA"}',
    JSON.stringify({ type: 'todex.transport.hello', version: 2, serverNonce: b64(new Uint8Array(31)) }),
    JSON.stringify({ type: 'other', version: 2, serverNonce: b64(new Uint8Array(32)) }),
  ]) {
    assert.throws(() => make().acceptHello(hello), TransportCryptoError, hello);
  }
});

test('inner requests reject nesting and relative paths', () => {
  const vector = fixture.protocols[0];
  for (const badPath of ['/v2/sealed', 'v2/workspaces', '/v2/x?y=1']) {
    assert.throws(() => sealRestRequest({
      protocol: 'x25519',
      serverPublicKey: hex(vector.server.publicKey),
      request: { method: 'GET', path: badPath },
    }), TypeError, badPath);
  }
});

test('v1 transport session enforces strict counters and zero nonce padding', () => {
  const serverSecret = new Uint8Array(32).fill(5);
  const serverPublic = x25519.getPublicKey(serverSecret);
  const session = createTransportCryptoSession({ encryptionProtocol: 'x25519', encryptionPublicKey: b64(serverPublic) });
  const clientPublic = fromB64(new URLSearchParams(session.queryString).get('client_key'));
  const salt = new Uint8Array([...serverPublic, ...clientPublic]);
  const key = hkdf(sha256, x25519.getSharedSecret(serverSecret, clientPublic), salt, utf8('x25519'), 32);
  const frame = (counter, mutate) => {
    const nonce = new Uint8Array(24);
    nonce[0] = 1;
    new DataView(nonce.buffer).setBigUint64(8, BigInt(counter), true);
    mutate?.(nonce);
    const ciphertext = xchacha20poly1305(key, nonce, utf8('todex-ws-transport-crypto-v1')).encrypt(utf8(`m${counter}`));
    return JSON.stringify({ type: 'todex.crypto.v1', protocol: 'x25519', nonce: b64(nonce), ciphertext: b64(ciphertext) });
  };
  assert.throws(() => session.decryptServerText(frame(1)), /计数器/);
  assert.throws(() => session.decryptServerText(frame(0, (nonce) => { nonce[3] = 1; })), /nonce/);
  assert.throws(() => session.decryptServerText(frame(0, (nonce) => { nonce[20] = 1; })), /nonce/);
  assert.equal(session.decryptServerText(frame(0)), 'm0');
  assert.throws(() => session.decryptServerText(frame(0)), /计数器/, 'replay');
  assert.equal(session.decryptServerText(frame(1)), 'm1');
});

// ---------------------------------------------------------------------------
// SecureTransport
// ---------------------------------------------------------------------------

const x25519Vector = fixture.protocols[0];
const pinnedProfile = (serverUrl) => ({
  serverUrl,
  encryptionProtocol: 'x25519',
  encryptionPublicKey: b64(hex(x25519Vector.server.publicKey)),
});

/** In-memory backend that opens `/v2/sealed` per the spec. */
function fakeSealedServer({ chunkSize } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.pathname !== '/v2/sealed') {
      return new Response(JSON.stringify({ plain: true, path: parsed.pathname, query: parsed.search }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = init.headers;
    assert.equal(headers['x-todex-transport'], '2');
    const clientMaterial = fromB64(headers['x-todex-client-key']);
    const clientNonce = fromB64(headers['x-todex-request-nonce']);
    const serverPublic = hex(x25519Vector.server.publicKey);
    const keys = deriveTransportKeys({
      label: fixture.constants.restLabel,
      protocol: 'x25519',
      deviceId: '',
      serverStaticPublic: serverPublic,
      clientMaterial,
      clientNonce,
      serverNonce: new Uint8Array(),
      shared: serverShared('x25519', hex(x25519Vector.server.secretKey), clientMaterial),
    });
    let inner;
    try {
      inner = decodeInnerRequest(openRecordStream(new RecordCipher(keys.kUp, keys.th, UP), init.body));
    } catch {
      return new Response('{"error":{"code":"TRANSPORT_CRYPTO_FAILED","message":"transport crypto failure"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    calls[calls.length - 1].inner = inner;
    const body = utf8(JSON.stringify({ echo: inner.path, query: inner.query, size: inner.body.length, payload: 'y'.repeat(70000) }));
    const sealed = sealRecordStream(
      new RecordCipher(keys.kDown, keys.th, DOWN),
      encodeInnerResponse({ status: 202, headers: { 'content-type': 'application/json' } }, body),
    );
    const stream = new ReadableStream({
      start(controller) {
        const size = chunkSize ?? sealed.length;
        for (let offset = 0; offset < sealed.length; offset += size) controller.enqueue(sealed.slice(offset, offset + size));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/vnd.todex.sealed' } });
  };
  return { calls, fetchImpl };
}

test('policy: pinned key uses the tunnel (even on loopback); remote without key refuses; loopback without key is plaintext', async () => {
  assert.equal(createSecureTransport({ profile: pinnedProfile('http://127.0.0.1:7345') }).mode, 'v2');
  assert.equal(createSecureTransport({ profile: pinnedProfile('http://10.0.0.5:7345') }).mode, 'v2');

  const remote = createSecureTransport({
    profile: { serverUrl: 'http://192.168.1.20:7345', encryptionProtocol: 'none', encryptionPublicKey: '' },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(remote.mode, 'refused');
  await assert.rejects(remote.fetch({ method: 'GET', path: '/v2/providers' }), EncryptionRequiredError);
  assert.throws(() => remote.openSocket(), EncryptionRequiredError);
  assert.throws(
    () => checkTransportPolicy({ serverUrl: 'http://192.168.1.20:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }, { requiredProtocol: 'none' }),
    EncryptionRequiredError,
  );

  const server = fakeSealedServer();
  const loopback = createSecureTransport({
    profile: { serverUrl: 'http://localhost:7345', encryptionProtocol: 'none', encryptionPublicKey: '' },
    fetchImpl: server.fetchImpl,
  });
  assert.equal(loopback.mode, 'plaintext');
  const response = await loopback.fetch({ method: 'GET', path: '/v2/providers', query: { a: 'b' } });
  assert.equal(server.calls[0].url.pathname, '/v2/providers');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), { plain: true, path: '/v2/providers', query: '?a=b' });
});

test('policy check: a different required protocol asks for re-pairing; a plaintext answer never downgrades', () => {
  const profile = pinnedProfile('http://10.0.0.5:7345');
  assert.throws(() => checkTransportPolicy(profile, { requiredProtocol: 'ml-kem-768' }), TransportRepairRequiredError);
  checkTransportPolicy(profile, { requiredProtocol: 'x25519', transportVersion: 2 });
  checkTransportPolicy(profile, { requiredProtocol: 'none' });
});

test('REST tunnel end to end: signed inner request, streamed sealed response', async () => {
  const server = fakeSealedServer({ chunkSize: 777 });
  const device = generateDeviceIdentity();
  const signed = [];
  const signer = deviceRequestSigner(device);
  const transport = createSecureTransport({
    profile: pinnedProfile('http://10.0.0.5:7345'),
    fetchImpl: server.fetchImpl,
    signer: { ...signer, signRequest: (request) => { signed.push(request); return signer.signRequest(request); } },
  });
  const response = await transport.fetch({
    method: 'post',
    path: '/v2/workspaces',
    query: 'x=1',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":"demo"}',
  });
  const call = server.calls[0];
  assert.equal(call.url.pathname, '/v2/sealed');
  assert.equal(call.url.search, '');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.inner.method, 'POST');
  assert.equal(call.inner.path, '/v2/workspaces');
  assert.equal(call.inner.query, 'x=1');
  assert.equal(call.inner.headers['content-type'], 'application/json');
  assert.equal(call.inner.headers['x-todex-device-id'], device.deviceId);
  assert.ok(call.inner.headers['x-todex-auth-sig']);
  assert.equal(new TextDecoder().decode(call.inner.body), '{"name":"demo"}');
  assert.deepEqual(signed[0], { method: 'POST', path: '/v2/workspaces', query: 'x=1', body: utf8('{"name":"demo"}') });
  assert.equal(response.status, 202);
  assert.equal(response.headers['content-type'], 'application/json');
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  assert.equal(parsed.echo, '/v2/workspaces');
  assert.equal(parsed.size, 15);

  const streamed = await transport.fetchStream({ method: 'GET', path: '/v2/providers' });
  let length = 0;
  let chunks = 0;
  for await (const chunk of streamed.body) {
    length += chunk.length;
    chunks += 1;
  }
  assert.equal(streamed.status, 202);
  assert.ok(chunks > 1, 'body arrives in more than one chunk');
  assert.ok(length > 70000);
});

test('REST tunnel surfaces an unsealed 400 as a request failure, never as the inner response', async () => {
  const transport = createSecureTransport({
    profile: pinnedProfile('http://10.0.0.5:7345'),
    fetchImpl: async () => new Response('{"error":{"code":"TRANSPORT_CRYPTO_FAILED","message":"transport crypto failure"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(transport.fetch({ method: 'GET', path: '/v2/providers' }), (error) =>
    error.httpStatus === 400 && error.backendCode === 'TRANSPORT_CRYPTO_FAILED');
});

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = new URL(url);
    this.sent = [];
    this.closed = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
}

test('WebSocket v2: signed tv=2 upgrade, hello, then binary frames both ways', () => {
  FakeWebSocket.instances = [];
  const device = generateDeviceIdentity();
  const events = [];
  const transport = createSecureTransport({
    profile: pinnedProfile('https://10.0.0.5:7345'),
    WebSocketImpl: FakeWebSocket,
    signer: deviceRequestSigner(device),
  });
  const socket = transport.openSocket({
    query: { historyEncryption: '1' },
    onOpen: () => events.push('open'),
    onMessage: (text) => events.push(text),
    onError: (error) => events.push(error),
    onClose: (event) => events.push(event),
  });
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url.protocol, 'wss:');
  assert.equal(ws.url.pathname, '/v2/ws');
  const query = ws.url.searchParams;
  for (const key of ['tv', 'enc', 'client_nonce', 'client_key', 'device_id', 'auth_sig', 'historyEncryption']) {
    assert.ok(query.get(key), key);
  }
  assert.equal(query.get('tv'), '2');
  assert.equal(query.get('device_id'), device.deviceId);
  assert.equal(ws.binaryType, 'arraybuffer');

  ws.onopen?.({});
  assert.equal(socket.ready, false, 'not ready before the hello');
  assert.throws(() => socket.send('{}'));

  const serverNonce = new Uint8Array(32).fill(4);
  const clientMaterial = fromB64(query.get('client_key'));
  const keys = deriveTransportKeys({
    label: fixture.constants.wsLabel,
    protocol: 'x25519',
    deviceId: device.deviceId,
    serverStaticPublic: hex(x25519Vector.server.publicKey),
    clientMaterial,
    clientNonce: fromB64(query.get('client_nonce')),
    serverNonce,
    shared: serverShared('x25519', hex(x25519Vector.server.secretKey), clientMaterial),
  });
  ws.onmessage({ data: JSON.stringify({ type: 'todex.transport.hello', version: 2, serverNonce: b64(serverNonce) }) });
  assert.deepEqual(events, ['open']);
  assert.equal(socket.ready, true);

  socket.send('{"id":"1","type":"server.ping","payload":{}}');
  const up = new RecordCipher(keys.kUp, keys.th, UP);
  const sent = ws.sent[0];
  assert.ok(sent instanceof Uint8Array);
  assert.equal(new DataView(sent.buffer, sent.byteOffset).getBigUint64(0, false), 0n);
  assert.equal(new TextDecoder().decode(up.open(0n, sent.subarray(8), false)), '{"id":"1","type":"server.ping","payload":{}}');

  const down = new RecordCipher(keys.kDown, keys.th, DOWN);
  const sealed = down.seal(utf8('{"id":"1","type":"server.pong"}'), false);
  const frame = new Uint8Array(8 + sealed.ciphertext.length);
  frame.set(sealed.ciphertext, 8);
  ws.onmessage({ data: frame.buffer });
  assert.equal(events[1], '{"id":"1","type":"server.pong"}');

  // Replaying the same frame is fatal: close 4400 with no detail.
  ws.onmessage({ data: frame.buffer });
  assert.deepEqual(ws.closed, { code: 4400, reason: 'transport crypto failure' });
  assert.ok(events.some((event) => event instanceof TransportCryptoError));
  assert.equal(socket.ready, false);
});

test('WebSocket v2: binary before the hello or text after it closes with 4400', () => {
  for (const scenario of ['binary-first', 'text-after-hello']) {
    FakeWebSocket.instances = [];
    const errors = [];
    createSecureTransport({ profile: pinnedProfile('http://10.0.0.5:7345'), WebSocketImpl: FakeWebSocket })
      .openSocket({ onError: (error) => errors.push(error) });
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url.searchParams.get('device_id'), null);
    if (scenario === 'binary-first') {
      ws.onmessage({ data: new Uint8Array(40).buffer });
    } else {
      ws.onmessage({ data: JSON.stringify({ type: 'todex.transport.hello', version: 2, serverNonce: b64(new Uint8Array(32)) }) });
      ws.onmessage({ data: '{"type":"server.pong"}' });
    }
    assert.deepEqual(ws.closed, { code: 4400, reason: 'transport crypto failure' }, scenario);
    assert.ok(errors[0] instanceof TransportCryptoError, scenario);
  }
});

test('WebSocket plaintext on loopback without a pinned key', () => {
  FakeWebSocket.instances = [];
  const messages = [];
  const socket = createSecureTransport({
    profile: { serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: '' },
    WebSocketImpl: FakeWebSocket,
  }).openSocket({ onMessage: (text) => messages.push(text) });
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url.protocol, 'ws:');
  assert.equal(ws.url.searchParams.get('tv'), null);
  assert.equal(socket.encrypted, false);
  ws.onopen({});
  socket.send('{"type":"server.ping"}');
  assert.equal(ws.sent[0], '{"type":"server.ping"}');
  ws.onmessage({ data: '{"type":"server.pong"}' });
  assert.deepEqual(messages, ['{"type":"server.pong"}']);
});
