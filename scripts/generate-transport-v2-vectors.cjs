#!/usr/bin/env node
// Regenerates tests/fixtures/transport-v2.json, the transport v2 vectors that
// the backend (Rust), TodexCore (Swift) and this package must all pass.
//
//   node scripts/generate-transport-v2-vectors.cjs
//
// Deliberately written against the @noble primitives directly, not against
// src/secureChannel.ts, so the fixture is a second, independent rendering of
// the spec and tests/unit/transport-v2.test.cjs cross-checks the two. All
// randomness comes from SHA-256 of fixed labels: the output is deterministic.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { xchacha20poly1305 } = require('@noble/ciphers/chacha.js');
const { ed25519, x25519 } = require('@noble/curves/ed25519.js');
const { expand, extract } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');

const enc = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const seed = (label, length = 32) => {
  const out = new Uint8Array(length);
  for (let block = 0; block * 32 < length; block += 1) {
    out.set(sha256(enc.encode(`todex.transport.v2/vector/${label}/${block}`)).subarray(0, length - block * 32), block * 32);
  }
  return out;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
};
const u64 = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
};
const lp = (bytes) => concat(u32(bytes.length), bytes);
const UP = 0x02;
const DOWN = 0x01;
const RECORD_MAX = 65536;

function schedule({ label, protocol, deviceId, serverPublic, clientMaterial, clientNonce, serverNonce, shared }) {
  const th = sha256(concat(
    lp(enc.encode(label)),
    lp(enc.encode(protocol)),
    lp(enc.encode(deviceId)),
    lp(serverPublic),
    lp(clientMaterial),
    lp(clientNonce),
    lp(serverNonce),
  ));
  const prk = extract(sha256, shared, th);
  return {
    th,
    kUp: expand(sha256, prk, enc.encode(`${label}/up`), 32),
    kDown: expand(sha256, prk, enc.encode(`${label}/down`), 32),
  };
}

function seal(key, th, direction, counter, final, plaintext) {
  const nonce = concat(new Uint8Array(16), u64(counter));
  return xchacha20poly1305(key, nonce, concat(th, Uint8Array.of(direction, final ? 1 : 0))).encrypt(plaintext);
}

function wsFrame(key, th, direction, counter, text) {
  return concat(u64(counter), seal(key, th, direction, counter, false, enc.encode(text)));
}

/** Records of a REST stream; `finalAt` overrides which record is final (failure cases). */
function restRecords(key, th, direction, plaintext, { firstCounter = 0, finalAt } = {}) {
  const records = [];
  let offset = 0;
  let index = 0;
  do {
    const end = Math.min(offset + RECORD_MAX, plaintext.length);
    const last = end === plaintext.length;
    const final = finalAt === undefined ? last : finalAt === index;
    const counter = firstCounter + index;
    records.push({ counter, final, plaintextLength: end - offset, ciphertext: seal(key, th, direction, counter, final, plaintext.subarray(offset, end)) });
    offset = end;
    index += 1;
  } while (offset < plaintext.length);
  return records;
}

const restStream = (records) => concat(...records.flatMap((record) => [u32(record.ciphertext.length), record.ciphertext]));

function inner(head, body = new Uint8Array()) {
  const headBytes = enc.encode(JSON.stringify(head));
  return { headJson: JSON.stringify(head), plaintext: concat(u32(headBytes.length), headBytes, body) };
}

const devicePublic = ed25519.getPublicKey(seed('device-seed'));
const deviceId = `dev_${b64(sha256(devicePublic).subarray(0, 12))}`;

function protocolVector(protocol) {
  let server;
  let client;
  let clientMaterial;
  let shared;
  // Separate client material per use, as in production: one ephemeral per
  // WebSocket handshake and one per REST request.
  const handshake = (use) => {
    if (protocol === 'x25519') {
      const secretKey = seed(`${protocol}/${use}/client-secret`);
      const publicKey = x25519.getPublicKey(secretKey);
      return {
        client: { secretKey: hex(secretKey), publicKey: hex(publicKey) },
        clientMaterial: publicKey,
        shared: x25519.getSharedSecret(secretKey, server.public),
      };
    }
    const message = seed(`${protocol}/${use}/encapsulation-message`);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(server.public, message);
    if (hex(ml_kem768.decapsulate(cipherText, server.secret)) !== hex(sharedSecret)) {
      throw new Error('ml-kem-768 self-check failed');
    }
    return {
      client: { encapsulationMessage: hex(message), ciphertext: hex(cipherText) },
      clientMaterial: cipherText,
      shared: sharedSecret,
    };
  };

  if (protocol === 'x25519') {
    const secret = seed(`${protocol}/server-secret`);
    server = { secret, public: x25519.getPublicKey(secret) };
  } else {
    const keys = ml_kem768.keygen(seed(`${protocol}/server-keygen-seed`, 64));
    server = { keygenSeed: seed(`${protocol}/server-keygen-seed`, 64), secret: keys.secretKey, public: keys.publicKey };
  }

  // --- WebSocket -----------------------------------------------------------
  ({ client, clientMaterial, shared } = handshake('ws'));
  const wsClientNonce = seed(`${protocol}/ws/client-nonce`);
  const wsServerNonce = seed(`${protocol}/ws/server-nonce`);
  const ws = schedule({
    label: 'todex.transport.v2/ws', protocol, deviceId, serverPublic: server.public,
    clientMaterial, clientNonce: wsClientNonce, serverNonce: wsServerNonce, shared,
  });
  const upMessages = [
    '{"id":"1","type":"server.ping","payload":{}}',
    '{"id":"2","type":"conversation.list","payload":{"limit":20}}',
  ];
  const downMessages = [
    '{"id":"1","type":"server.pong","payload":{}}',
    '{"type":"conversation.event","payload":{"text":"你好, transport v2 ✓"}}',
    '{"id":"2","type":"conversation.list.result","payload":{"conversations":[]}}',
  ];
  const frames = [
    ...upMessages.map((text, counter) => ({ direction: 'up', counter, plaintext: text, frame: hex(wsFrame(ws.kUp, ws.th, UP, counter, text)) })),
    ...downMessages.map((text, counter) => ({ direction: 'down', counter, plaintext: text, frame: hex(wsFrame(ws.kDown, ws.th, DOWN, counter, text)) })),
  ];
  const down0 = Buffer.from(frames.find((frame) => frame.direction === 'down').frame, 'hex');
  const flipped = Uint8Array.from(down0);
  flipped[flipped.length - 1] ^= 0x01;
  const wsVector = {
    label: 'todex.transport.v2/ws',
    deviceId,
    client,
    clientMaterial: hex(clientMaterial),
    clientNonce: hex(wsClientNonce),
    serverNonce: hex(wsServerNonce),
    shared: hex(shared),
    query: {
      tv: '2',
      enc: protocol,
      client_nonce: b64(wsClientNonce),
      [protocol === 'x25519' ? 'client_key' : 'ciphertext']: b64(clientMaterial),
    },
    hello: JSON.stringify({ type: 'todex.transport.hello', version: 2, serverNonce: b64(wsServerNonce) }),
    th: hex(ws.th),
    kUp: hex(ws.kUp),
    kDown: hex(ws.kDown),
    frames,
  };

  // --- REST ----------------------------------------------------------------
  ({ client, clientMaterial, shared } = handshake('rest'));
  const restClientNonce = seed(`${protocol}/rest/client-nonce`);
  const rest = schedule({
    label: 'todex.transport.v2/rest', protocol, deviceId: '', serverPublic: server.public,
    clientMaterial, clientNonce: restClientNonce, serverNonce: new Uint8Array(), shared,
  });
  const requestBody = enc.encode('{"name":"demo","path":"/tmp/demo"}');
  const request = inner({
    method: 'POST',
    path: '/v2/workspaces',
    query: 'source=vector',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-todex-device-id': deviceId,
      'x-todex-auth-ts': '1760000000',
      'x-todex-auth-nonce': 'AAAAAAAAAAAAAAAAAAAAAA',
      'x-todex-auth-sig': 'vector-signature-not-verified',
    },
  }, requestBody);
  const requestRecords = restRecords(rest.kUp, rest.th, UP, request.plaintext);
  const responseBody = enc.encode('{"workspace":{"id":"ws_1","name":"demo"}}');
  const response = inner({ status: 201, headers: { 'content-type': 'application/json' } }, responseBody);
  const responseRecords = restRecords(rest.kDown, rest.th, DOWN, response.plaintext);
  const responseStream = restStream(responseRecords);

  // Multi-record response: a 140000-byte body, byte i = i % 251. Only digests
  // are pinned to keep the fixture small; implementations seal the same
  // plaintext with k_down and compare.
  const bigBody = Uint8Array.from({ length: 140000 }, (_, index) => index % 251);
  const big = inner({ status: 200, headers: { 'content-type': 'application/octet-stream' } }, bigBody);
  const bigRecords = restRecords(rest.kDown, rest.th, DOWN, big.plaintext);
  const bigStream = restStream(bigRecords);

  const flippedStream = Uint8Array.from(responseStream);
  flippedStream[flippedStream.length - 1] ^= 0x01;
  const tooLong = Uint8Array.from(responseStream);
  new DataView(tooLong.buffer).setUint32(0, RECORD_MAX + 16 + 1, false);
  const twoRecordPlaintext = concat(response.plaintext);
  const finalFirst = restStream([
    { ciphertext: seal(rest.kDown, rest.th, DOWN, 0, true, twoRecordPlaintext.subarray(0, 10)) },
    { ciphertext: seal(rest.kDown, rest.th, DOWN, 1, true, twoRecordPlaintext.subarray(10)) },
  ]);

  const restVector = {
    label: 'todex.transport.v2/rest',
    deviceId: '',
    client,
    clientMaterial: hex(clientMaterial),
    clientNonce: hex(restClientNonce),
    serverNonce: '',
    shared: hex(shared),
    th: hex(rest.th),
    kUp: hex(rest.kUp),
    kDown: hex(rest.kDown),
    outerHeaders: {
      'content-type': 'application/vnd.todex.sealed',
      'x-todex-transport': '2',
      'x-todex-encryption': protocol,
      [protocol === 'x25519' ? 'x-todex-client-key' : 'x-todex-kem-ciphertext']: b64(clientMaterial),
      'x-todex-request-nonce': b64(restClientNonce),
    },
    request: {
      headJson: request.headJson,
      body: hex(requestBody),
      plaintext: hex(request.plaintext),
      stream: hex(restStream(requestRecords)),
    },
    response: {
      status: 201,
      headJson: response.headJson,
      body: hex(responseBody),
      plaintext: hex(response.plaintext),
      stream: hex(responseStream),
    },
    multiRecordResponse: {
      headJson: big.headJson,
      bodyLength: bigBody.length,
      bodyPattern: 'byte[i] = i % 251',
      plaintextLength: big.plaintext.length,
      plaintextSha256: hex(sha256(big.plaintext)),
      records: bigRecords.map((record) => ({
        counter: record.counter,
        final: record.final,
        plaintextLength: record.plaintextLength,
        ciphertextLength: record.ciphertext.length,
        ciphertextSha256: hex(sha256(record.ciphertext)),
      })),
      streamLength: bigStream.length,
      streamSha256: hex(sha256(bigStream)),
    },
  };

  const failures = [
    { name: 'ws-wrong-counter', kind: 'ws', receive: 'down', input: frames.filter((frame) => frame.direction === 'down')[1].frame, note: 'counter 1 while 0 is expected' },
    { name: 'ws-flipped-tag-bit', kind: 'ws', receive: 'down', input: hex(flipped) },
    { name: 'ws-wrong-direction', kind: 'ws', receive: 'down', input: frames[0].frame, note: 'an up frame offered to the client' },
    { name: 'ws-short-frame', kind: 'ws', receive: 'down', input: hex(down0.subarray(0, 23)) },
    { name: 'rest-truncated', kind: 'rest', receive: 'down', input: hex(responseStream.subarray(0, responseStream.length - 1)) },
    { name: 'rest-trailing-bytes', kind: 'rest', receive: 'down', input: hex(concat(responseStream, Uint8Array.of(0))) },
    { name: 'rest-missing-final', kind: 'rest', receive: 'down', input: hex(restStream(restRecords(rest.kDown, rest.th, DOWN, response.plaintext, { finalAt: -1 }))) },
    { name: 'rest-final-not-last', kind: 'rest', receive: 'down', input: hex(finalFirst) },
    { name: 'rest-wrong-counter', kind: 'rest', receive: 'down', input: hex(restStream(restRecords(rest.kDown, rest.th, DOWN, response.plaintext, { firstCounter: 1 }))) },
    { name: 'rest-flipped-tag-bit', kind: 'rest', receive: 'down', input: hex(flippedStream) },
    { name: 'rest-record-too-long', kind: 'rest', receive: 'down', input: hex(tooLong) },
    { name: 'rest-wrong-direction', kind: 'rest', receive: 'down', input: restVector.request.stream, note: 'the up request stream offered as a response' },
    { name: 'rest-empty', kind: 'rest', receive: 'down', input: '' },
  ];

  return {
    protocol,
    server: {
      ...(server.keygenSeed ? { keygenSeed: hex(server.keygenSeed) } : {}),
      secretKey: hex(server.secret),
      publicKey: hex(server.public),
    },
    ws: wsVector,
    rest: restVector,
    failures,
  };
}

function pairingVector() {
  const requestId = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
  const clientSecret = seed('pairing/client-secret');
  const serverSecret = seed('pairing/server-secret');
  const clientPublic = x25519.getPublicKey(clientSecret);
  const serverPublic = x25519.getPublicKey(serverSecret);
  const clientNonce = seed('pairing/client-nonce');
  const shared = x25519.getSharedSecret(clientSecret, serverPublic);
  const commitment = sha256(concat(lp(enc.encode('todex.device-pairing.v3/commit')), clientPublic, clientNonce));
  // The transport key the pairing binds: the ml-kem-768 server static key of
  // the protocol vectors above.
  const transportProtocol = 'ml-kem-768';
  const transportPublicKey = ml_kem768.keygen(seed('ml-kem-768/server-keygen-seed', 64)).publicKey;
  const tamperedPublicKey = ml_kem768.keygen(seed('pairing/tampered-keygen-seed', 64)).publicKey;
  const transcriptFor = (protocol, key) => concat(
    enc.encode('todex.device-pairing.v3/transcript\0'),
    enc.encode(requestId),
    Uint8Array.of(0),
    clientPublic,
    serverPublic,
    Uint8Array.of(0),
    devicePublic,
    clientNonce,
    lp(enc.encode(protocol)),
    lp(key),
  );
  const code = (hash) => {
    const short = hex(hash.subarray(0, 5)).toUpperCase();
    return `${short.slice(0, 5)}-${short.slice(5)}`;
  };
  const transcript = transcriptFor(transportProtocol, transportPublicKey);
  const transcriptHash = sha256(transcript);
  const prk = extract(sha256, shared, transcriptHash);
  const wrapKey = expand(sha256, prk, enc.encode('todex.device-pairing.v3/wrap-key'), 32);
  // Field order is the backend's serde struct order.
  const credentialPlaintext = JSON.stringify({
    deviceId: 'dev_vector',
    transportProtocol,
    transportPublicKey: b64(transportPublicKey),
  });
  const credentialNonce = seed('pairing/credential-nonce', 24);
  const credentialCiphertext = xchacha20poly1305(wrapKey, credentialNonce, transcript).encrypt(enc.encode(credentialPlaintext));
  const fingerprint = hex(sha256(transportPublicKey).subarray(0, 8)).toUpperCase().match(/.{4}/g).join('-');
  const tamperedHash = sha256(transcriptFor(transportProtocol, tamperedPublicKey));
  const noneHash = sha256(transcriptFor('none', new Uint8Array()));
  return {
    requestId,
    clientSecretKey: hex(clientSecret),
    clientPublicKey: hex(clientPublic),
    serverSecretKey: hex(serverSecret),
    serverPublicKey: hex(serverPublic),
    deviceSeed: hex(seed('device-seed')),
    devicePublicKey: hex(devicePublic),
    clientNonce: hex(clientNonce),
    shared: hex(shared),
    commitment: hex(commitment),
    commitmentBase64Url: b64(commitment),
    transportProtocol,
    transportPublicKey: b64(transportPublicKey),
    transcript: hex(transcript),
    transcriptHash: hex(transcriptHash),
    verificationCode: code(transcriptHash),
    wrapKey: hex(wrapKey),
    pollProof: hex(expand(sha256, prk, enc.encode('todex.device-pairing.v3/poll-proof'), 32)),
    cancelProof: hex(expand(sha256, prk, enc.encode('todex.device-pairing.v3/cancel-proof'), 32)),
    credential: {
      plaintext: credentialPlaintext,
      nonce: hex(credentialNonce),
      nonceBase64Url: b64(credentialNonce),
      ciphertext: hex(credentialCiphertext),
      ciphertextBase64Url: b64(credentialCiphertext),
    },
    fingerprint,
    tampered: {
      transportProtocol,
      transportPublicKey: b64(tamperedPublicKey),
      transcriptHash: hex(tamperedHash),
      verificationCode: code(tamperedHash),
    },
    noneCase: {
      transportProtocol: 'none',
      transportPublicKey: '',
      transcriptHash: hex(noneHash),
      verificationCode: code(noneHash),
      fingerprint: 'none',
    },
  };
}

const fixture = {
  description: 'TodeX transport v2 vectors. Binary values are lowercase hex; header/query values and pairing wire fields (transportPublicKey, *Base64Url) are base64url without padding. Generated by TodeX_protocol/scripts/generate-transport-v2-vectors.cjs; do not edit by hand.',
  version: 2,
  constants: {
    wsLabel: 'todex.transport.v2/ws',
    restLabel: 'todex.transport.v2/rest',
    directionUp: UP,
    directionDown: DOWN,
    recordPlaintextMax: RECORD_MAX,
    tagLength: 16,
    wsCloseCode: 4400,
    wsCloseReason: 'transport crypto failure',
    failureCode: 'TRANSPORT_CRYPTO_FAILED',
  },
  protocols: [protocolVector('x25519'), protocolVector('ml-kem-768')],
  pairingV3: pairingVector(),
};

const target = path.join(__dirname, '..', 'tests', 'fixtures', 'transport-v2.json');
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), target)} (${fs.statSync(target).size} bytes)`);
