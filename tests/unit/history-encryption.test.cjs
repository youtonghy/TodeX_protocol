const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  HistoryContentStream,
  encodeHistoryWrappedKey,
  generateHistoryRecipientKeyPair,
  historyRecipientId,
  newHistorySegmentKey,
  sealHistoryContent,
  unwrapHistoryKey,
  decodeHistoryWrappedKey,
  wrapHistoryKey,
} = require(path.join(lib, 'historyCrypto.js'));
const {
  HistoryDecryptor,
  historyCommands,
  historyRetryPrompt,
  historyRetryRequest,
  historyRetrySequence,
  historyWrapsFetcher,
  parseHistoryEncryptionState,
  rewrapHistoryKeys,
} = require(path.join(lib, 'historyEncryption.js'));
const { applyConversationRuntimeEvents, createConversationRuntime } = require(path.join(lib, 'conversationRuntime.js'));
const { buildV2WebSocketUrlWithOptions } = require(path.join(lib, 'v2.js'));

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const json = (value) => new TextEncoder().encode(JSON.stringify(value));
const CONVERSATION = 'conv_1';

/** A backend stand-in: keyring of kid → wraps per rid, plus a call log. */
function keyring() {
  const wraps = new Map();
  const calls = [];
  return {
    calls,
    grant(key, publicKey) {
      const rid = b64(historyRecipientId(publicKey));
      const entry = wraps.get(rid) ?? {};
      entry[b64(key.kid)] = encodeHistoryWrappedKey(wrapHistoryKey(key, publicKey));
      wraps.set(rid, entry);
    },
    fetchWraps: async ({ conversationId, kids, rid }) => {
      calls.push({ conversationId, kids: [...kids], rid });
      const entry = wraps.get(rid) ?? {};
      return Object.fromEntries(kids.filter((kid) => entry[kid]).map((kid) => [kid, entry[kid]]));
    },
  };
}

function eventLevel(key, sequence, envelope, summary, full) {
  const enc = { v: 1, kid: b64(key.kid), c: CONVERSATION, n: sequence,
    f: b64(sealHistoryContent(key, CONVERSATION, HistoryContentStream.EventFull, sequence, json(full))) };
  if (summary) enc.s = b64(sealHistoryContent(key, CONVERSATION, HistoryContentStream.EventSummary, sequence, json(summary)));
  return { eventId: `evt_${sequence}`, conversationId: CONVERSATION, sequence, time: '2026-10-06T00:00:00Z', type: 'message.delta',
    payload: { ...envelope, $enc: enc } };
}

test('event-level ciphertext opens per detail; plaintext events pass through in order', async () => {
  const device = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const ring = keyring();
  ring.grant(key, device.publicKey);
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps });
  const plain = { eventId: 'evt_1', conversationId: CONVERSATION, sequence: 1, time: 't', type: 'turn.started', payload: { turnId: 't1' } };
  const both = eventLevel(key, 2, { turnId: 't1', role: 'assistant' }, { turnId: 't1', role: 'assistant', detailStub: true }, { turnId: 't1', role: 'assistant', delta: { text: 'full' } });
  const fullOnly = eventLevel(key, 3, { turnId: 't1' }, null, { turnId: 't1', delta: { text: 'same' } });
  const page = { conversationId: CONVERSATION, fromSequence: 0, nextSequence: 3, hasMore: false, events: [plain, both, fullOnly] };

  const summary = await decryptor.decryptPage(page, 'summary');
  assert.deepEqual(summary.events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(summary.events[0], plain);
  assert.deepEqual(summary.events[1].payload, { turnId: 't1', role: 'assistant', detailStub: true });
  assert.deepEqual(summary.events[2].payload, { turnId: 't1', delta: { text: 'same' } });
  const full = await decryptor.decryptPage(page, 'full');
  assert.deepEqual(full.events[1].payload.delta, { text: 'full' });
  // One wraps request for the single kid; the second page hit the cache.
  assert.equal(ring.calls.length, 1);
  assert.deepEqual(ring.calls[0], { conversationId: CONVERSATION, kids: [b64(key.kid)], rid: decryptor.recipientIds[0] });
  // Pages without ciphertext are returned as-is.
  const clear = { conversationId: CONVERSATION, events: [plain] };
  assert.equal(await decryptor.decryptPage(clear, 'summary'), clear);
});

test('frame-level ciphertext is raw DEFLATE and resolves through the page frames map', async () => {
  const device = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const ring = keyring();
  ring.grant(key, device.publicKey);
  const summaries = [{ turnId: 't', n: 0, detailStub: true }, { turnId: 't', n: 1, detailStub: true }];
  const fulls = [{ turnId: 't', n: 0, text: 'a' }, { turnId: 't', n: 1, text: 'b' }];
  const frames = {
    fs: { kid: b64(key.kid), stream: 3, counter: 7, c: 'conv_source', ct: b64(sealHistoryContent(key, 'conv_source', 3, 7, zlib.deflateRawSync(Buffer.from(JSON.stringify(summaries))))) },
    ff: { kid: b64(key.kid), stream: 4, counter: 8, c: 'conv_source', ct: b64(sealHistoryContent(key, 'conv_source', 4, 8, zlib.deflateRawSync(Buffer.from(JSON.stringify(fulls))))) },
  };
  const events = [0, 1].map((index) => ({ eventId: `e${index}`, conversationId: CONVERSATION, sequence: index + 1, time: 't', type: 'tool.updated',
    payload: { turnId: 't', $enc: { v: 1, kid: b64(key.kid), c: 'conv_source', n: 40 + index, fr: { s: 'fs', f: 'ff', i: index } } } }));
  // The default inflater is DecompressionStream('deflate-raw').
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps });

  const summary = await decryptor.decryptPage({ conversationId: CONVERSATION, events, frames }, 'summary');
  assert.equal('frames' in summary, false);
  assert.deepEqual(summary.events.map((event) => event.payload), summaries);
  const full = await decryptor.decryptPage({ conversationId: CONVERSATION, events, frames }, 'full');
  assert.deepEqual(full.events.map((event) => event.payload), fulls);
  // Each frame is opened and inflated once per page, shared by its events.
  const inflated = [];
  const counting = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps,
    inflateFrame: (bytes) => { inflated.push(bytes.length); return zlib.inflateRawSync(bytes); } });
  await counting.decryptPage({ conversationId: CONVERSATION, events, frames }, 'full');
  assert.equal(inflated.length, 1);
  // A frame that is not DEFLATE locks its events instead of failing the page.
  const raw = { ...frames.fs, ct: b64(sealHistoryContent(key, 'conv_source', 3, 7, json(summaries))) };
  const notDeflate = await decryptor.decryptPage({ conversationId: CONVERSATION, events, frames: { fs: raw } }, 'summary');
  assert.equal(notDeflate.events[0].payload.detailLocked, true);
  // A summary-only page still serves a full request from the frame it has.
  const onlySummary = await decryptor.decryptPage({ conversationId: CONVERSATION, events, frames: { fs: frames.fs } }, 'full');
  assert.deepEqual(onlySummary.events.map((event) => event.payload), summaries);
  // A missing frame locks only the events that point at it.
  const missing = await decryptor.decryptPage({ conversationId: CONVERSATION, events, frames: {} }, 'summary');
  assert.deepEqual(missing.events.map((event) => event.payload), [{ turnId: 't', detailLocked: true }, { turnId: 't', detailLocked: true }]);
});

test('no wrap for this device, wrong recipient and tampering lock events without dropping them', async () => {
  const device = generateHistoryRecipientKeyPair();
  const other = generateHistoryRecipientKeyPair();
  const granted = newHistorySegmentKey();
  const foreign = newHistorySegmentKey();
  const ring = keyring();
  ring.grant(granted, device.publicKey);
  ring.grant(foreign, other.publicKey);
  let now = 1_000;
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps, missingTtlMs: 100, now: () => now });
  const good = eventLevel(granted, 1, { turnId: 't' }, null, { turnId: 't', text: 'ok' });
  const tampered = eventLevel(granted, 2, { turnId: 't', role: 'assistant' }, null, { text: 'x' });
  tampered.payload.$enc.f = b64(Buffer.from(tampered.payload.$enc.f, 'base64url').map((byte, index) => index === 0 ? byte ^ 1 : byte));
  const wrongCounter = eventLevel(granted, 3, { turnId: 't' }, null, { text: 'y' });
  wrongCounter.payload.$enc.n = 4;
  const locked = eventLevel(foreign, 4, { turnId: 't', messageId: 'm' }, null, { text: 'secret' });
  const result = await decryptor.decryptEvents([good, tampered, wrongCounter, locked], { detail: 'full' });
  assert.deepEqual(result.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(result[0].payload, { turnId: 't', text: 'ok' });
  assert.deepEqual(result[1].payload, { turnId: 't', role: 'assistant', detailLocked: true });
  assert.deepEqual(result[2].payload, { turnId: 't', detailLocked: true });
  assert.deepEqual(result[3].payload, { turnId: 't', messageId: 'm', detailLocked: true });

  // A kid without a wrap is not asked for again until its TTL passes.
  const calls = ring.calls.length;
  await decryptor.decryptEvents([locked], { detail: 'full' });
  assert.equal(ring.calls.length, calls);
  now += 101;
  await decryptor.decryptEvents([locked], { detail: 'full' });
  assert.equal(ring.calls.length, calls + 1);

  // A backend answering with another recipient's wrap is still locked.
  const lying = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: async ({ kids }) =>
    Object.fromEntries(kids.map((kid) => [kid, encodeHistoryWrappedKey(wrapHistoryKey(foreign, other.publicKey))])) });
  assert.equal((await lying.decryptEvents([locked], { detail: 'full' }))[0].payload.detailLocked, true);
  // No seed at all: everything locked without asking the backend.
  const keyless = new HistoryDecryptor({ fetchWraps: async () => { throw new Error('must not fetch'); } });
  assert.equal((await keyless.decryptEvents([good], { detail: 'full' }))[0].payload.detailLocked, true);
});

test('transport failures propagate instead of locking', async () => {
  const device = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: async () => { throw new Error('offline'); } });
  await assert.rejects(decryptor.decryptEvents([eventLevel(key, 1, {}, null, {})], { detail: 'full' }), /offline/);
});

test('an imported recovery seed opens kids the device itself was never given', async () => {
  const device = generateHistoryRecipientKeyPair();
  const recovery = generateHistoryRecipientKeyPair();
  const old = newHistorySegmentKey();
  const ring = keyring();
  ring.grant(old, recovery.publicKey);
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey, recovery.secretKey], fetchWraps: ring.fetchWraps });
  const [event] = await decryptor.decryptEvents([eventLevel(old, 1, {}, null, { text: 'old' })], { detail: 'full' });
  assert.equal(event.payload.text, 'old');
  assert.deepEqual(ring.calls.map((call) => call.rid), decryptor.recipientIds);
});

test('unwrapped DEKs are bounded by an LRU and the sync path needs a warm cache', async () => {
  const device = generateHistoryRecipientKeyPair();
  const ring = keyring();
  const keys = [newHistorySegmentKey(), newHistorySegmentKey(), newHistorySegmentKey()];
  for (const key of keys) ring.grant(key, device.publicKey);
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps, maxKeys: 2 });
  const events = keys.map((key, index) => eventLevel(key, index + 1, {}, null, { index }));
  assert.equal(decryptor.tryDecryptEvents([events[0]], { detail: 'full' }), null);
  for (const event of events) await decryptor.decryptEvents([event], { detail: 'full' });
  assert.equal(ring.calls.length, 3);
  // keys[0] was evicted; keys[2] is still warm.
  assert.equal(decryptor.tryDecryptEvents([events[0]], { detail: 'full' }), null);
  assert.deepEqual(decryptor.tryDecryptEvents([events[2]], { detail: 'full' })[0].payload, { index: 2 });
  await decryptor.decryptEvents([events[0]], { detail: 'full' });
  assert.equal(ring.calls.length, 4);
  // Plaintext batches take the sync path untouched.
  const plain = { conversationId: CONVERSATION, sequence: 9, payload: { text: 'p' } };
  assert.deepEqual(decryptor.tryDecryptEvents([plain], { detail: 'summary' }), [plain]);
  decryptor.clear();
  assert.deepEqual(decryptor.recipientIds, []);
});

test('encrypted titles decrypt with stream 2 counter 0', async () => {
  const device = generateHistoryRecipientKeyPair();
  const key = newHistorySegmentKey();
  const ring = keyring();
  ring.grant(key, device.publicKey);
  const decryptor = new HistoryDecryptor({ seeds: [device.secretKey], fetchWraps: ring.fetchWraps });
  const ct = b64(sealHistoryContent(key, CONVERSATION, HistoryContentStream.EventFull, 0, new TextEncoder().encode('重构 journal')));
  assert.equal(await decryptor.decryptTitle(CONVERSATION, { kid: b64(key.kid), ct }), '重构 journal');
  assert.equal(await decryptor.decryptTitle('other', { kid: b64(key.kid), ct }), null);
  assert.equal(await decryptor.decryptTitle(CONVERSATION, undefined), null);
});

test('locked events project one quiet notice per turn and never append', () => {
  const locked = (sequence, type, payload) => ({ schemaVersion: 1, eventId: `e${sequence}`, conversationId: CONVERSATION, sequence, time: '2026-10-06T00:00:00Z', type, payload });
  const { state } = applyConversationRuntimeEvents(createConversationRuntime(CONVERSATION, 'ws'), [
    locked(1, 'turn.started', { turnId: 't1', detailLocked: true }),
    locked(2, 'message.created', { turnId: 't1', role: 'user', detailLocked: true }),
    locked(3, 'message.delta', { turnId: 't1', role: 'assistant', detailLocked: true }),
    locked(4, 'message.delta', { turnId: 't1', role: 'assistant', detailLocked: true }),
    locked(5, 'turn.completed', { turnId: 't1', status: 'completed', detailLocked: true }),
  ]);
  const rows = state.timeline.filter((entry) => entry.detailLocked);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subtitle, '此设备尚未获授权查看这段历史');
  assert.equal(state.appliedSequence, 5);
  assert.equal(state.activeTurnId, '');
});

test('retry carries the latest user message of the newest-first timeline', () => {
  const event = (sequence, type, payload) => ({ schemaVersion: 1, eventId: `e${sequence}`, conversationId: CONVERSATION, sequence, time: '2026-10-06T00:00:00Z', type, payload });
  const turn = (base, id, text) => [
    event(base, 'message.created', { turnId: id, role: 'user', content: text }),
    event(base + 1, 'message.completed', { turnId: id, role: 'assistant', message: { text: `re: ${text}` } }),
    event(base + 2, 'turn.completed', { turnId: id, status: 'completed' }),
  ];
  const { state } = applyConversationRuntimeEvents(createConversationRuntime(CONVERSATION, 'ws'), [
    ...turn(1, 't1', 'first prompt'), ...turn(4, 't2', 'second prompt  '),
  ]);
  assert.equal(historyRetryPrompt(state.timeline), 'second prompt  ');
  const locked = applyConversationRuntimeEvents(state, [event(7, 'message.created', { turnId: 't3', role: 'user', detailLocked: true })]).state;
  assert.equal(historyRetryPrompt(locked.timeline), null);
  assert.equal(historyRetryPrompt([]), null);
  assert.equal(historyRetrySequence(state.timeline), 4);
  assert.equal(historyRetrySequence(locked.timeline), null);
  assert.equal(historyRetrySequence([]), null);
});

test('retry request is read from the full user message payload', () => {
  const content = [{ type: 'text', text: 'inline' }, { type: 'file', path: '/w/a.txt' }];
  assert.deepEqual(
    historyRetryRequest({ role: 'user', content: 'x', retryRequest: { text: '', content } }),
    { text: '', content },
  );
  assert.equal(historyRetryRequest({ role: 'user', content: 'x' }), null);
  assert.equal(historyRetryRequest({ retryRequest: { text: 1, content: [] } }), null);
  assert.equal(historyRetryRequest(null), null);
});

test('command frames validate their batch limits', () => {
  assert.deepEqual(historyCommands.listKeys({ cursor: 'c', limit: 9000 }), { type: 'history.keys.list', payload: { cursor: 'c', limit: 500 } });
  assert.throws(() => historyCommands.wraps('c', []), /最多/);
  assert.throws(() => historyCommands.wraps('c', new Array(501).fill('k')), /最多/);
  assert.throws(() => historyCommands.fulfill('rid', []), /最多/);
  assert.deepEqual(historyCommands.fulfill('rid', [], 'g', true).payload, { grantId: 'g', rid: 'rid', wraps: [], complete: true });
  assert.deepEqual(historyCommands.fulfill('rid', [{ conversationId: 'c', kid: 'k', wrapped: {} }]).payload, { rid: 'rid', wraps: [{ conversationId: 'c', kid: 'k', wrapped: {} }] });
  assert.equal(historyCommands.register(new Uint8Array([1, 2])).payload.publicKey, 'AQI');
  const state = parseHistoryEncryptionState({ mode: 'e2e', epoch: 3, myRid: 'r1', recipients: [{ rid: 'r1', kind: 'device', deviceId: 'dev_1', publicKey: 'pk', addedAt: 'a', revokedAt: null }, { bad: true }], grants: [{ grantId: 'g', rid: 'r2', deviceId: 'dev_2', requestedAt: 'b', status: 'fulfilled', publicKey: 'pk2' }, { grantId: 'h', rid: 'r3', status: 'weird' }, { grantId: 'i', rid: 'r4' }] });
  assert.equal(state.recipients.length, 1);
  assert.deepEqual(state.grants[0], { grantId: 'g', rid: 'r2', deviceId: 'dev_2', requestedAt: 'b', status: 'fulfilled', publicKey: 'pk2' });
  assert.deepEqual(state.grants.map((grant) => [grant.grantId, grant.status]), [['g', 'fulfilled'], ['i', 'pending']]);
  assert.throws(() => parseHistoryEncryptionState({ mode: 'maybe' }), /格式无效/);
  const url = new URL(buildV2WebSocketUrlWithOptions('http://127.0.0.1:1', { historyEncryption: true }));
  assert.equal(url.searchParams.get('historyEncryption'), '1');
});

test('grant re-wrap walks keys.list pages, re-wraps for the target and resumes from a cursor', async () => {
  const source = generateHistoryRecipientKeyPair();
  const target = generateHistoryRecipientKeyPair();
  const sourceRid = b64(historyRecipientId(source.publicKey));
  const targetRid = b64(historyRecipientId(target.publicKey));
  const keys = [newHistorySegmentKey(), newHistorySegmentKey(), newHistorySegmentKey()];
  const items = [{ conversationId: 'a', key: keys[0] }, { conversationId: 'a', key: keys[1] }, { conversationId: 'b', key: keys[2] }];
  const ring = keyring();
  ring.grant(keys[0], source.publicKey);
  ring.grant(keys[2], source.publicKey);
  const sent = [];
  const fulfilled = [];
  const completes = [];
  const send = async ({ type, payload }) => {
    sent.push(type);
    if (type === 'history.keys.list') {
      const start = payload.cursor ? Number(payload.cursor) : 0;
      const page = items.slice(start, start + payload.limit);
      const next = start + payload.limit < items.length ? String(start + payload.limit) : undefined;
      return { items: page.map(({ conversationId, key }) => ({ conversationId, kid: b64(key.kid) })), ...(next ? { nextCursor: next } : {}) };
    }
    if (type === 'history.keys.wraps') {
      assert.equal(payload.rid, sourceRid);
      return { wraps: await ring.fetchWraps(payload) };
    }
    if (type === 'history.grant.fulfill') {
      assert.equal(payload.rid, targetRid);
      assert.equal(payload.grantId, 'grt_1');
      completes.push(payload.complete === true);
      fulfilled.push(...payload.wraps);
      return { added: payload.wraps.length };
    }
    throw new Error(`unexpected ${type}`);
  };
  const progress = [];
  const result = await rewrapHistoryKeys({ send, sourceSeed: source.secretKey, targetPublicKey: target.publicKey, grantId: 'grt_1', batchSize: 2, onProgress: (value) => progress.push(value) });
  assert.deepEqual(result, { processed: 3, added: 2, skipped: 1 });
  assert.deepEqual(progress.map((value) => value.cursor), ['2', undefined]);
  // Only the last batch of the grant is marked complete.
  assert.deepEqual(completes, [false, true]);
  // The target can open what it was given.
  for (const wrap of fulfilled) {
    const key = items.find((item) => b64(item.key.kid) === wrap.kid).key;
    assert.deepEqual(unwrapHistoryKey(target.secretKey, decodeHistoryWrappedKey(wrap.wrapped), key.kid).dek, key.dek);
  }
  // The caller's seed is not zeroed by the helper.
  assert.ok(source.secretKey.some((byte) => byte !== 0));

  // Resuming from the reported cursor only walks the rest.
  fulfilled.length = 0;
  const resumed = await rewrapHistoryKeys({ send, sourceSeed: source.secretKey, targetPublicKey: target.publicKey, grantId: 'grt_1', batchSize: 2, cursor: '2' });
  assert.deepEqual(resumed, { processed: 1, added: 1, skipped: 0 });
  assert.deepEqual(completes.slice(2), [true]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(rewrapHistoryKeys({ send, sourceSeed: source.secretKey, targetPublicKey: target.publicKey, signal: controller.signal }), /Abort/);
});

test('historyWrapsFetcher speaks history.keys.wraps', async () => {
  const frames = [];
  const fetch = historyWrapsFetcher(async (frame) => { frames.push(frame); return { wraps: { k: { rid: 'r', kemCt: 'c', wrapped: 'w' }, bad: { rid: 1 } } }; });
  assert.deepEqual(await fetch({ conversationId: 'c', kids: ['k', 'bad'], rid: 'r' }), { k: { rid: 'r', kemCt: 'c', wrapped: 'w' } });
  assert.deepEqual(frames, [{ type: 'history.keys.wraps', payload: { conversationId: 'c', kids: ['k', 'bad'], rid: 'r' } }]);
});
