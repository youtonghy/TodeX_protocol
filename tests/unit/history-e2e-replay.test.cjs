const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Backend-generated replay fixture (TodeX_backend
// tests/fixtures/history-e2e-replay.json, copied verbatim): a conversation
// with a sealed segment (frame-level `fr`, counter = segment << 32) and
// active records (event-level `s`/`f`), as REST pages in both details and as
// the socket's summary backfill, plus an encrypted manifest title.
const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { HistoryDecryptor } = require(path.join(lib, 'historyEncryption.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'history-e2e-replay.json'), 'utf8'));

function decryptor() {
  const calls = [];
  const instance = new HistoryDecryptor({
    seeds: [Buffer.from(fixture.seed, 'hex')],
    // Default inflate path (DecompressionStream 'deflate-raw'), as in browsers.
    fetchWraps: async ({ conversationId, kids, rid }) => {
      calls.push({ conversationId, kids: [...kids], rid });
      assert.equal(conversationId, fixture.conversationId);
      assert.equal(rid, fixture.rid);
      return Object.fromEntries(kids.flatMap((kid) => {
        const wrap = (fixture.keyring[kid] ?? []).find((entry) => entry.rid === rid);
        return wrap ? [[kid, wrap]] : [];
      }));
    },
  });
  return { instance, calls };
}

for (const [detail, expected] of [['full', fixture.expected], ['summary', fixture.expectedSummary]]) {
  test(`REST ${detail} page decrypts to the backend's plaintext`, async () => {
    const { instance, calls } = decryptor();
    assert.deepEqual(instance.recipientIds, [fixture.rid]);
    const page = fixture.pages[detail];
    assert.ok(Object.values(page.frames).some((frame) => frame.counter >= 2 ** 32), "fixture covers counters of 2^32 and up");
    const opened = await instance.decryptPage(page, detail);
    assert.equal(opened.frames, undefined);
    assert.deepEqual(opened.events.map((event) => event.sequence), page.events.map((event) => event.sequence));
    assert.deepEqual(opened.events.map((event) => event.payload), expected);
    // One wraps request covers every kid of the page.
    assert.equal(calls.length, 1);
  });
}

test('socket summary backfill decrypts message by message with each message\'s frames', async () => {
  const { instance } = decryptor();
  const payloads = [];
  for (const message of fixture.socketBackfillSummary) {
    assert.equal(message.type, 'conversation.event');
    const [event] = await instance.decryptEvents([message.payload], {
      frames: message.frames, detail: 'summary', conversationId: fixture.conversationId,
    });
    payloads.push(event.payload);
  }
  assert.deepEqual(payloads, fixture.expectedSummary);
});

test('encrypted manifest title opens; the plaintext title is omitted', async () => {
  assert.equal(fixture.manifest.title, undefined);
  const { instance } = decryptor();
  assert.equal(await instance.decryptTitle(fixture.conversationId, fixture.manifest.titleEnc), fixture.manifest.expectedTitle);
});

test('without a wrap for this device every event stays in place, locked', async () => {
  const instance = new HistoryDecryptor({ seeds: [Buffer.alloc(32, 9)], fetchWraps: async () => ({}) });
  const opened = await instance.decryptPage(fixture.pages.full, 'full');
  assert.equal(opened.events.length, fixture.expected.length);
  for (const event of opened.events) {
    assert.equal(event.payload.detailLocked, true);
    assert.equal(event.payload.$enc, undefined);
    assert.equal(event.payload.turnId, fixture.expected[event.sequence - 1].turnId);
  }
});
