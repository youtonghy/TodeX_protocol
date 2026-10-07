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
  DevicePairingTransportError,
  deriveDevicePairingV3Material,
  deriveTransportKeys,
  devicePairingV3Commitment,
  devicePairingV3Transcript,
  parseDevicePairingTransport,
  transportFingerprint,
  verifyDevicePairingCredential,
  encodeInnerResponse,
  openRecordStream,
  openRestResponse,
  openRestResponseStream,
  sealRecordStream,
  sealRestRequest,
} = channel;
const {
  EncryptionRequiredError,
  InvalidPinnedKeyError,
  TransportPolicyError,
  TransportRepairRequiredError,
  cachedSecureTransport,
  checkTransportPolicy,
  createSecureTransport,
  deviceRequestSigner,
  toFetchResponse,
  secureTransportRefusal,
  verifyTransportPolicy,
} = require(path.join(compiledDir, 'secureTransport.js'));
const { parsePairingAddress } = require(path.join(compiledDir, 'transportCrypto.js'));
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

function pairingMaterial(vector, transportProtocol, transportPublicKey) {
  return deriveDevicePairingV3Material({
    requestId: vector.requestId,
    clientSecretKey: hex(vector.clientSecretKey),
    serverPublic: hex(vector.serverPublicKey),
    devicePublic: hex(vector.devicePublicKey),
    clientNonce: hex(vector.clientNonce),
    transportProtocol,
    transportPublicKey: fromB64(transportPublicKey),
  });
}

test('pairing v3 commitment, transcript, code and keys match the vector', () => {
  const vector = fixture.pairingV3;
  assert.equal(toHex(devicePairingV3Commitment(hex(vector.clientPublicKey), hex(vector.clientNonce))), vector.commitment);
  // The bound key is the ml-kem-768 static key of the protocol vectors.
  const mlKem = fixture.protocols.find((entry) => entry.protocol === 'ml-kem-768');
  assert.equal(vector.transportProtocol, 'ml-kem-768');
  assert.equal(toHex(fromB64(vector.transportPublicKey)), mlKem.server.publicKey);
  const material = pairingMaterial(vector, vector.transportProtocol, vector.transportPublicKey);
  assert.equal(toHex(material.transcript), vector.transcript);
  assert.equal(toHex(material.transcriptHash), vector.transcriptHash);
  assert.equal(material.verificationCode, vector.verificationCode);
  assert.match(material.verificationCode, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  assert.equal(toHex(material.wrapKey), vector.wrapKey);
  assert.equal(toHex(material.pollProof), vector.pollProof);
  assert.equal(toHex(material.cancelProof), vector.cancelProof);
  // The transcript ends with LP(protocol) || LP(key).
  const tail = Buffer.concat([
    Buffer.from([0, 0, 0, 10]), Buffer.from('ml-kem-768'), Buffer.from([0, 0, 0x04, 0xa0]), Buffer.from(fromB64(vector.transportPublicKey)),
  ]);
  assert.equal(toHex(material.transcript.subarray(material.transcript.length - tail.length)), tail.toString('hex'));
});

test('pairing v3: a different transport key or none changes transcript and code', () => {
  const vector = fixture.pairingV3;
  const tampered = pairingMaterial(vector, vector.tampered.transportProtocol, vector.tampered.transportPublicKey);
  assert.equal(toHex(tampered.transcriptHash), vector.tampered.transcriptHash);
  assert.equal(tampered.verificationCode, vector.tampered.verificationCode);
  assert.notEqual(tampered.verificationCode, vector.verificationCode);

  const none = pairingMaterial(vector, 'none', '');
  assert.equal(toHex(none.transcriptHash), vector.noneCase.transcriptHash);
  assert.equal(none.verificationCode, vector.noneCase.verificationCode);
  assert.deepEqual([...none.transcript.subarray(none.transcript.length - 12)], [0, 0, 0, 4, ...Buffer.from('none'), 0, 0, 0, 0]);
  assert.equal(transportFingerprint('none', ''), vector.noneCase.fingerprint);

  const base = {
    requestId: vector.requestId,
    clientPublic: hex(vector.clientPublicKey),
    serverPublic: hex(vector.serverPublicKey),
    devicePublic: hex(vector.devicePublicKey),
    clientNonce: hex(vector.clientNonce),
  };
  assert.throws(() => devicePairingV3Transcript({ ...base, transportProtocol: 'x25519', transportPublicKey: new Uint8Array(31) }), TypeError);
  assert.throws(() => devicePairingV3Transcript({ ...base, transportProtocol: 'none', transportPublicKey: new Uint8Array(1) }), TypeError);
  assert.throws(() => devicePairingV3Transcript({ ...base, transportProtocol: 'rot13', transportPublicKey: new Uint8Array() }), TypeError);
});

test('pairing v3: the approval credential decrypts and pins exactly the create-response key', () => {
  const vector = fixture.pairingV3;
  const material = pairingMaterial(vector, vector.transportProtocol, vector.transportPublicKey);
  const plaintext = xchacha20poly1305(material.wrapKey, fromB64(vector.credential.nonceBase64Url), material.transcript)
    .decrypt(fromB64(vector.credential.ciphertextBase64Url));
  assert.equal(new TextDecoder().decode(plaintext), vector.credential.plaintext);
  assert.equal(toHex(fromB64(vector.credential.ciphertextBase64Url)), vector.credential.ciphertext);
  const credential = JSON.parse(vector.credential.plaintext);
  assert.deepEqual(Object.keys(credential), ['deviceId', 'transportProtocol', 'transportPublicKey']);

  const transport = parseDevicePairingTransport(
    { transportProtocol: vector.transportProtocol, transportPublicKey: vector.transportPublicKey },
    'https://10.0.0.5:7345',
  );
  assert.deepEqual(verifyDevicePairingCredential(credential, { deviceId: 'dev_vector', transport }), {
    encryptionProtocol: 'ml-kem-768',
    encryptionPublicKey: vector.transportPublicKey,
  });
  assert.equal(transportFingerprint(transport.protocol, transport.publicKey), vector.fingerprint);
  assert.equal(transportFingerprint(transport.protocol, transport.publicKeyRaw), vector.fingerprint);
  assert.match(vector.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

  const mismatch = (error) => error instanceof DevicePairingTransportError && error.reason === 'mismatch';
  assert.throws(() => verifyDevicePairingCredential(credential, { deviceId: 'dev_other', transport }), mismatch);
  assert.throws(() => verifyDevicePairingCredential({ ...credential, transportPublicKey: vector.tampered.transportPublicKey }, { deviceId: 'dev_vector', transport }), mismatch);
  assert.throws(() => verifyDevicePairingCredential({ ...credential, transportProtocol: 'x25519' }, { deviceId: 'dev_vector', transport }), mismatch);
  assert.throws(() => verifyDevicePairingCredential({ deviceId: 'dev_vector' }, { deviceId: 'dev_vector', transport }), mismatch);
  assert.throws(() => verifyDevicePairingCredential(null, { deviceId: 'dev_vector', transport }), mismatch);
  // The tampered transcript cannot open the credential.
  const tampered = pairingMaterial(vector, vector.tampered.transportProtocol, vector.tampered.transportPublicKey);
  assert.throws(() => xchacha20poly1305(tampered.wrapKey, fromB64(vector.credential.nonceBase64Url), tampered.transcript)
    .decrypt(fromB64(vector.credential.ciphertextBase64Url)));
});

test('pairing v3: create-response transport fields are validated before use', () => {
  const vector = fixture.pairingV3;
  const x25519Key = b64(hex(fixture.protocols[0].server.publicKey));
  const invalid = (error) => error instanceof DevicePairingTransportError && error.reason === 'invalid';
  const parse = (transportProtocol, transportPublicKey, url = 'http://10.0.0.5:7345') =>
    parseDevicePairingTransport({ transportProtocol, transportPublicKey }, url);

  const ok = parse('x25519', x25519Key);
  assert.equal(ok.protocol, 'x25519');
  assert.equal(ok.publicKey, x25519Key);
  assert.equal(toHex(ok.publicKeyRaw), fixture.protocols[0].server.publicKey);
  assert.equal(parse('ml-kem-768', vector.transportPublicKey).publicKeyRaw.length, 1184);

  assert.throws(() => parse(undefined, x25519Key), invalid);
  assert.throws(() => parse('X25519', x25519Key), invalid);
  assert.throws(() => parse('x25519', undefined), invalid);
  assert.throws(() => parse('x25519', x25519Key.slice(0, -2)), invalid, 'short key');
  assert.throws(() => parse('x25519', `${x25519Key}=`), invalid, 'padding');
  assert.throws(() => parse('x25519', x25519Key.replace(/^./, '+')), invalid, 'standard alphabet');
  assert.throws(() => parse('x25519', b64(new Uint8Array(32))), invalid, 'low-order point');
  assert.throws(() => parse('x25519', b64(Uint8Array.of(1, ...new Uint8Array(31)))), invalid, 'low-order point 1');
  assert.throws(() => parse('ml-kem-768', x25519Key), invalid, 'wrong length');
  assert.throws(() => parse('ml-kem-768', b64(new Uint8Array(1184).fill(0xff))), invalid, 'coefficients out of range');
  assert.throws(() => parse('x25519', vector.transportPublicKey), invalid, 'ml-kem key as x25519');

  const required = (error) => error instanceof DevicePairingTransportError && error.reason === 'encryption_required';
  assert.throws(() => parse('none', ''), required);
  assert.throws(() => parse('none', '', 'http://user@127.0.0.1:7345'), required);
  assert.throws(() => parse('none', '', 'not a url'), required);
  for (const url of ['http://127.0.0.1:7345', 'http://localhost:7345/', 'ws://[::1]:7345', new URL('https://127.0.0.2')]) {
    assert.deepEqual(parse('none', '', url), { protocol: 'none', publicKey: '', publicKeyRaw: new Uint8Array() });
  }
  assert.throws(() => parse('none', 'AAAA', 'http://127.0.0.1:7345'), invalid);
  assert.throws(() => transportFingerprint('x25519', 'AA=='), TypeError);
  assert.throws(() => transportFingerprint('x25519', ''), TypeError);
});

test('pairing links only carry the server address', () => {
  assert.equal(parsePairingAddress('{"kind":"todex-pairing-link","version":2,"serverUrl":"http://10.0.0.5:7345"}'), 'http://10.0.0.5:7345');
  // Version 1 links may still carry protocol fields; they are ignored.
  assert.equal(parsePairingAddress(JSON.stringify({
    kind: 'todex-pairing-link',
    version: 1,
    serverUrl: ' http://10.0.0.6:7345 ',
    authToken: 'legacy',
    preferredEncryption: 'x25519',
    protocol: { id: 'x25519', publicKey: 'attacker-key' },
  })), 'http://10.0.0.6:7345');
  assert.equal(parsePairingAddress(' https://todex.example:7345/ '), 'https://todex.example:7345/');
  for (const raw of [
    '{"kind":"todex-pairing-link","version":3,"serverUrl":"http://a"}',
    '{"kind":"todex-pairing-chunk","version":1,"checksum":"x","index":1,"total":2,"data":"e30"}',
    '{"kind":"todex-pairing-link","version":2}',
    '{"kind":"todex-pairing-link","version":2,"serverUrl":""}',
    '{',
    '[]',
    'ftp://host',
    'hello world',
    '',
  ]) {
    assert.throws(() => parsePairingAddress(raw), Error, raw);
  }
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

// ---------------------------------------------------------------------------
// SecureTransport
// ---------------------------------------------------------------------------

const x25519Vector = fixture.protocols[0];
const pinnedProfile = (serverUrl, transportVerified = true) => ({
  serverUrl,
  encryptionProtocol: 'x25519',
  encryptionPublicKey: b64(hex(x25519Vector.server.publicKey)),
  transportVerified,
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
  // A redirect must not replay the (signed) request to another URL.
  assert.equal(server.calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), { plain: true, path: '/v2/providers', query: '?a=b' });
});

test('policy: a pin that device pairing did not verify is refused everywhere, never plaintext', async () => {
  const repair = (error) => error instanceof TransportRepairRequiredError && error.required === null;
  const unverified = [
    pinnedProfile('http://127.0.0.1:7345', false),
    pinnedProfile('http://10.0.0.5:7345', undefined),
    { ...pinnedProfile('http://localhost:7345'), transportVerified: 'true' },
    { serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'x25519', encryptionPublicKey: '' },
    { serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: 'stale-key' },
  ];
  unverified[1].transportVerified = undefined;
  for (const profile of unverified) {
    const transport = createSecureTransport({ profile, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(transport.mode, 'refused', JSON.stringify(profile));
    assert.ok(repair(secureTransportRefusal(profile)));
    await assert.rejects(transport.fetch({ method: 'GET', path: '/v2/providers' }), repair);
    assert.throws(() => transport.openSocket(), repair);
    assert.throws(() => checkTransportPolicy(profile, { requiredProtocol: 'x25519', transportVersion: 2 }), repair);
    await assert.rejects(verifyTransportPolicy(profile, { fetchImpl: async () => { throw new Error('must not be called'); } }), repair);
    assert.match(secureTransportRefusal(profile).message, /重新配对/);
  }
  // A verified but incomplete pin is unusable, not plaintext.
  assert.ok(secureTransportRefusal({ serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'x25519', encryptionPublicKey: '', transportVerified: true }) instanceof InvalidPinnedKeyError);
  // Loopback with no key stays plaintext, verified or not; remote stays refused.
  assert.equal(secureTransportRefusal({ serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }), null);
  assert.equal(secureTransportRefusal({ serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: '', transportVerified: true }), null);
  assert.ok(secureTransportRefusal({ serverUrl: 'http://10.0.0.5:7345', encryptionProtocol: 'none', encryptionPublicKey: '', transportVerified: true }) instanceof EncryptionRequiredError);
  assert.equal(secureTransportRefusal(pinnedProfile('http://10.0.0.5:7345')), null);
  // The verification flag is part of the cache key.
  const device = generateDeviceIdentity();
  const verified = cachedSecureTransport(pinnedProfile('http://10.0.0.11:7345'), device);
  const stale = cachedSecureTransport(pinnedProfile('http://10.0.0.11:7345', false), device);
  assert.notEqual(stale, verified);
  assert.equal(stale.mode, 'refused');
  assert.equal(verified.mode, 'v2');
});

test('REST bodies over the limit are refused before anything is sent', async () => {
  assert.equal(channel.MAX_REST_BODY_BYTES, 32 * 1024 * 1024);
  for (const profile of [pinnedProfile('http://10.0.0.5:7345'), { serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }]) {
    const server = fakeSealedServer();
    const transport = createSecureTransport({ profile, fetchImpl: server.fetchImpl, maxBodyBytes: 16 });
    await assert.rejects(
      transport.fetch({ method: 'POST', path: '/v2/workspaces', body: 'x'.repeat(17) }),
      (error) => error instanceof channel.TransportPayloadTooLargeError && error.size === 17 && error.limit === 16,
    );
    assert.equal(server.calls.length, 0);
    await transport.fetch({ method: 'POST', path: '/v2/workspaces', body: 'x'.repeat(16) });
    assert.equal(server.calls.length, 1);
  }
});

test('policy check: a different required protocol asks for re-pairing; a plaintext answer never downgrades', () => {
  const profile = pinnedProfile('http://10.0.0.5:7345');
  assert.throws(() => checkTransportPolicy(profile, { requiredProtocol: 'ml-kem-768', transportVersion: 2 }), TransportRepairRequiredError);
  checkTransportPolicy(profile, { requiredProtocol: 'x25519', transportVersion: 2 });
  // `none` has no static key to run v2 against: re-pair, never plaintext.
  assert.throws(() => checkTransportPolicy(profile, { requiredProtocol: 'none', transportVersion: 2 }), TransportRepairRequiredError);
  // A backend without transport v2 cannot serve a pinned profile.
  assert.throws(() => checkTransportPolicy(profile, { requiredProtocol: 'x25519' }),
    (error) => error instanceof TransportPolicyError && error.reason === 'outdated' && !error.retryable);
  // Loopback without a key stays plaintext whatever the policy says.
  checkTransportPolicy({ serverUrl: 'http://127.0.0.1:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }, { requiredProtocol: 'x25519' });
});

test('verifyTransportPolicy: refuses unpaired remotes offline, reads the policy directly, classifies failures', async () => {
  const policyFetch = (respond) => {
    const calls = [];
    return { calls, fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return respond(); } };
  };
  const unpaired = policyFetch(() => { throw new Error('must not be called'); });
  await assert.rejects(
    verifyTransportPolicy({ serverUrl: 'http://192.168.1.20:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }, { fetchImpl: unpaired.fetchImpl }),
    EncryptionRequiredError,
  );
  assert.equal(unpaired.calls.length, 0);

  for (const encryptionPublicKey of ['AAAA', '!!', b64(new Uint8Array(32))]) {
    await assert.rejects(
      verifyTransportPolicy({ serverUrl: 'http://10.0.0.5:7345', encryptionProtocol: 'x25519', encryptionPublicKey, transportVerified: true }, { fetchImpl: unpaired.fetchImpl }),
      InvalidPinnedKeyError,
      encryptionPublicKey,
    );
  }
  assert.equal(unpaired.calls.length, 0);

  const ok = policyFetch(() => Response.json({ requiredProtocol: 'x25519', transportVersion: 2 }));
  await verifyTransportPolicy(pinnedProfile('http://10.0.0.5:7345/'), { fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls[0].url.href, 'http://10.0.0.5:7345/v2/transport-policy');
  assert.equal(ok.calls[0].init.credentials, 'omit');
  assert.equal(ok.calls[0].init.headers['x-todex-device-id'], undefined, 'unsigned');

  const cases = [
    [() => Response.json({ requiredProtocol: 'ml-kem-768', transportVersion: 2 }), (error) => error instanceof TransportRepairRequiredError],
    [() => new Response('nope', { status: 404 }), (error) => error.reason === 'outdated' && !error.retryable],
    [() => new Response('', { status: 503 }), (error) => error.reason === 'http' && error.retryable && error.status === 503],
    [() => new Response('{', { status: 200 }), (error) => error.reason === 'invalid' && !error.retryable],
    [() => Response.json({ requiredProtocol: 'rot13' }), (error) => error.reason === 'invalid'],
    [() => { throw new TypeError('Failed to fetch'); }, (error) => error.reason === 'unreachable' && error.retryable],
  ];
  for (const [respond, check] of cases) {
    await assert.rejects(verifyTransportPolicy(pinnedProfile('http://10.0.0.5:7345'), { fetchImpl: policyFetch(respond).fetchImpl }), check);
  }
  const hanging = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(verifyTransportPolicy(pinnedProfile('http://10.0.0.5:7345'), { fetchImpl: hanging, timeoutMs: 5 }),
    (error) => error.reason === 'timeout' && error.retryable);
  const controller = new AbortController();
  const pending = verifyTransportPolicy(pinnedProfile('http://10.0.0.5:7345'), { fetchImpl: hanging, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('toFetchResponse and cachedSecureTransport', async () => {
  const response = toFetchResponse({ status: 409, headers: { 'content-type': 'application/json' }, body: utf8('{"code":"CONFLICT"}') });
  assert.equal(response.ok, false);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: 'CONFLICT' });
  assert.equal(toFetchResponse({ status: 204, headers: {}, body: new Uint8Array() }).status, 204);

  const device = generateDeviceIdentity();
  const first = cachedSecureTransport(pinnedProfile('http://10.0.0.9:7345'), device);
  assert.equal(cachedSecureTransport(pinnedProfile('http://10.0.0.9:7345/'), device), first, 'same profile, same instance');
  assert.equal(first.mode, 'v2');
  const unpaired = cachedSecureTransport({ serverUrl: 'http://10.0.0.9:7345', encryptionProtocol: 'none', encryptionPublicKey: '' }, device);
  assert.notEqual(unpaired, first, 'a changed profile rebuilds');
  assert.equal(unpaired.mode, 'refused');
  assert.notEqual(cachedSecureTransport(pinnedProfile('http://10.0.0.9:7345'), device), first, 'the replaced profile was dropped');
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
  assert.equal(call.init.redirect, 'error');
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

test('V2ApiClient and the backend probe go through the tunnel when a key is pinned', async () => {
  const { V2ApiClient } = require(path.join(compiledDir, 'v2.js'));
  const { probeBackendConnection } = require(path.join(compiledDir, 'connectionProbe.js'));
  const server = fakeSealedServer();
  const transport = createSecureTransport({ profile: pinnedProfile('http://127.0.0.1:7345'), fetchImpl: server.fetchImpl });
  const api = new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', transport });
  const result = await api.prompt('c 1', 'hello');
  assert.equal(result.echo, '/v2/conversations/c%201/prompt');
  const call = server.calls[0];
  assert.equal(call.url.pathname, '/v2/sealed');
  assert.equal(call.inner.method, 'POST');
  assert.equal(call.inner.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(call.inner.body)), { text: 'hello' });

  await api.listConversations();
  assert.equal(server.calls[1].inner.path, '/v2/conversations');

  const probe = await probeBackendConnection({ serverUrl: 'http://127.0.0.1:7345', transport });
  assert.equal(probe.ok, true);
  assert.deepEqual(server.calls.slice(2).map((item) => [item.url.pathname, item.inner.path]), [
    ['/v2/sealed', '/v2/version'], ['/v2/sealed', '/health'], ['/v2/sealed', '/v2/providers'],
  ]);

  // Without a key a remote client never reaches the network.
  const refused = new V2ApiClient({ serverUrl: 'http://10.0.0.5:7345', fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(refused.listConversations(), EncryptionRequiredError);
  const pin = { encryptionProtocol: 'x25519', encryptionPublicKey: pinnedProfile('').encryptionPublicKey };
  const unverified = new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', ...pin, fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(unverified.listConversations(), TransportRepairRequiredError);
  const verified = new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', ...pin, transportVerified: true, fetchImpl: server.fetchImpl });
  await verified.listConversations();
  assert.equal(server.calls.at(-1).url.pathname, '/v2/sealed');
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
  assert.equal(socket.closed, true);
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
