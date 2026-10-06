const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  HistoryContentStream,
  decodeHistoryWrappedKey,
  encodeHistoryWrappedKey,
  generateHistoryRecipientKeyPair,
  historyRecipientId,
  historyRecipientKeyPairFromSeed,
  newHistorySegmentKey,
  openHistoryContent,
  sealHistoryContent,
  unwrapHistoryKey,
  wrapHistoryKey,
} = require(path.join(compiledDir, 'historyCrypto.js'));

// Verbatim backend tests/fixtures/history-crypto-v1.json; synthetic keys only.
const vector = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'history-crypto-v1.json'), 'utf8'),
);
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

function vectorKey() {
  const wrapped = decodeHistoryWrappedKey(vector.wrap.json);
  return unwrapHistoryKey(hex(vector.seed), wrapped, hex(vector.kid));
}

test('the backend vector derives the same public key and recipient id', () => {
  const { publicKey } = historyRecipientKeyPairFromSeed(hex(vector.seed));
  assert.equal(toHex(publicKey), vector.pk);
  assert.equal(toHex(historyRecipientId(publicKey)), vector.rid);
  assert.equal(Buffer.from(historyRecipientId(publicKey)).toString('base64url'), vector.ridText);
});

test('the backend vector wrapped key unwraps to the DEK and re-encodes identically', () => {
  const wrapped = decodeHistoryWrappedKey(vector.wrap.json);
  assert.equal(toHex(wrapped.kemCt), vector.wrap.kemCt);
  assert.equal(toHex(wrapped.wrapped), vector.wrap.wrapped);
  assert.deepEqual(encodeHistoryWrappedKey(wrapped), vector.wrap.json);
  const key = vectorKey();
  assert.equal(toHex(key.dek), vector.dek);
  assert.equal(toHex(key.kid), vector.kid);
});

test('content cases seal byte-for-byte and open back', () => {
  const key = vectorKey();
  assert.equal(vector.content.length, 4);
  for (const entry of vector.content) {
    const sealed = sealHistoryContent(key, vector.conversationId, entry.stream, entry.counter, hex(entry.plaintext));
    assert.equal(toHex(sealed), entry.ciphertext);
    const opened = openHistoryContent(key, vector.conversationId, entry.stream, BigInt(entry.counter), sealed);
    assert.equal(toHex(opened), entry.plaintext);
  }
});

test('random keys round trip through wrap, JSON and seal', () => {
  const recipient = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const first = wrapHistoryKey(key, recipient.publicKey);
  const second = wrapHistoryKey(key, recipient.publicKey);
  assert.notEqual(toHex(first.kemCt), toHex(second.kemCt));
  const parsed = decodeHistoryWrappedKey(JSON.parse(JSON.stringify(encodeHistoryWrappedKey(first))));
  const unwrapped = unwrapHistoryKey(recipient.secretKey, parsed, key.kid);
  assert.equal(toHex(unwrapped.dek), toHex(key.dek));
  const plaintext = new TextEncoder().encode('历史 🔐');
  const sealed = sealHistoryContent(key, 'c', HistoryContentStream.EventFull, 7, plaintext);
  assert.equal(sealed.length, plaintext.length + 16);
  assert.deepEqual(openHistoryContent(unwrapped, 'c', HistoryContentStream.EventFull, 7n, sealed), plaintext);
});

test('tampering, wrong context and wrong recipient are rejected', () => {
  const recipient = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const sealed = sealHistoryContent(key, 'c1', HistoryContentStream.FrameFull, 3, new Uint8Array([1, 2, 3]));
  const flipped = Uint8Array.from(sealed);
  flipped[0] ^= 1;
  assert.throws(() => openHistoryContent(key, 'c1', HistoryContentStream.FrameFull, 3, flipped));
  assert.throws(() => openHistoryContent(key, 'c2', HistoryContentStream.FrameFull, 3, sealed));
  assert.throws(() => openHistoryContent(key, 'c1', HistoryContentStream.FrameSummary, 3, sealed));
  assert.throws(() => openHistoryContent(key, 'c1', HistoryContentStream.FrameFull, 4, sealed));
  assert.throws(() => openHistoryContent({ kid: key.kid, dek: newHistorySegmentKey().dek }, 'c1', 4, 3, sealed));

  const wrapped = wrapHistoryKey(key, recipient.publicKey);
  const other = generateHistoryRecipientKeyPair();
  assert.throws(() => unwrapHistoryKey(other.secretKey, wrapped, key.kid), /不属于当前设备/);
  assert.throws(() => unwrapHistoryKey(recipient.secretKey, wrapped, new Uint8Array(16)), /认证失败/);
  const badWrap = { ...wrapped, wrapped: Uint8Array.from(wrapped.wrapped) };
  badWrap.wrapped[0] ^= 1;
  assert.throws(() => unwrapHistoryKey(recipient.secretKey, badWrap, key.kid), /认证失败/);
  const badKem = { ...wrapped, kemCt: Uint8Array.from(wrapped.kemCt) };
  badKem.kemCt[0] ^= 1;
  assert.throws(() => unwrapHistoryKey(recipient.secretKey, badKem, key.kid), /认证失败/);
});

test('inputs are validated', () => {
  const key = newHistorySegmentKey();
  for (const stream of [0, 5]) {
    assert.throws(() => sealHistoryContent(key, 'c', stream, 0, new Uint8Array()), /内容流编号无效/);
  }
  for (const counter of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n << 64n]) {
    assert.throws(() => sealHistoryContent(key, 'c', 1, counter, new Uint8Array()), /计数无效/);
  }
  assert.doesNotThrow(() => sealHistoryContent(key, 'c', 1, (1n << 64n) - 1n, new Uint8Array()));
  assert.throws(() => wrapHistoryKey(key, new Uint8Array(1215)), /公钥长度无效/);
  assert.throws(() => wrapHistoryKey(key, new Uint8Array(1216).fill(255)), /公钥无效/);
  assert.throws(() => decodeHistoryWrappedKey({ rid: 'AA', kemCt: 'AA', wrapped: 'AA' }), /格式无效/);
});
