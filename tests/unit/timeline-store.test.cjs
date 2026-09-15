const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { ConversationReplayTracker, TimelineStore } = require(path.join(compiledDir, 'lib', 'timelineStore.js'));

function entry(id, workspaceId, conversationId, subtitle = id) {
  return {
    id,
    kind: 'system',
    title: id,
    subtitle,
    raw: '',
    at: Number(id.replace(/\D/g, '')) || 1,
    workspaceId,
    conversationId,
  };
}

test('timeline store notifies only the conversation whose snapshot changed', () => {
  const store = new TimelineStore(20);
  store.replace([entry('a1', 'w1', 'c1'), entry('b1', 'w1', 'c2')]);
  const beforeC2 = store.getConversationSnapshot('w1', 'c2');
  let c1Updates = 0;
  let c2Updates = 0;
  store.subscribeConversation('w1', 'c1', () => { c1Updates += 1; });
  store.subscribeConversation('w1', 'c2', () => { c2Updates += 1; });

  store.append(entry('a2', 'w1', 'c1'));

  assert.equal(c1Updates, 1);
  assert.equal(c2Updates, 0);
  assert.equal(store.getConversationSnapshot('w1', 'c2'), beforeC2);
});

test('timeline store scopes equal conversation ids by workspace', () => {
  const store = new TimelineStore(20);
  store.replace([entry('a1', 'w1', 'same'), entry('b1', 'w2', 'same')]);

  assert.deepEqual(store.getConversationSnapshot('w1', 'same').map((item) => item.id), ['a1']);
  assert.deepEqual(store.getConversationSnapshot('w2', 'same').map((item) => item.id), ['b1']);
});

test('timeline store preserves references for no-op upserts and merges streamed text once', () => {
  const store = new TimelineStore(20);
  const initial = entry('a1', 'w1', 'c1', 'hello');
  store.replace([initial]);
  const before = store.getConversationSnapshot('w1', 'c1');
  let updates = 0;
  store.subscribeConversation('w1', 'c1', () => { updates += 1; });

  store.upsertBatch([{ entry: initial, appendSubtitle: false }]);
  assert.equal(store.getConversationSnapshot('w1', 'c1'), before);
  assert.equal(updates, 0);

  store.upsertBatch([{ entry: { ...initial, subtitle: ' world', at: 2 }, appendSubtitle: true }]);
  assert.equal(store.getConversationSnapshot('w1', 'c1')[0].subtitle, 'hello world');
  assert.equal(updates, 1);
});

test('timeline store ignores raw-only changes from legacy persisted entries', () => {
  const store = new TimelineStore(20);
  const initial = { ...entry('a1', 'w1', 'c1', 'hello'), raw: '{"legacy":true}' };
  store.replace([initial]);
  const before = store.getConversationSnapshot('w1', 'c1');
  let updates = 0;
  store.subscribeConversation('w1', 'c1', () => { updates += 1; });

  store.upsertBatch([{ entry: { ...initial, raw: '' }, appendSubtitle: false }]);

  assert.equal(store.getConversationSnapshot('w1', 'c1'), before);
  assert.equal(updates, 0);
});

test('timeline store applies semantic changes even when text and time are unchanged', () => {
  const store = new TimelineStore(20);
  const progress = {
    ...entry('a1', 'w1', 'c1', 'same text'),
    category: 'assistant_progress',
    phase: 'delta',
  };
  store.replace([progress]);
  let updates = 0;
  store.subscribeConversation('w1', 'c1', () => { updates += 1; });

  store.upsertBatch([{ entry: {
    ...progress,
    kind: 'incoming',
    category: 'assistant_final',
    phase: 'completed',
  }, appendSubtitle: false }]);

  assert.equal(updates, 1);
  assert.equal(store.getConversationSnapshot('w1', 'c1')[0].kind, 'incoming');
  assert.equal(store.getConversationSnapshot('w1', 'c1')[0].category, 'assistant_final');
});

test('timeline store enforces its global retention limit', () => {
  const store = new TimelineStore(3);
  store.replace([
    entry('a4', 'w1', 'c1'),
    entry('a3', 'w1', 'c1'),
    entry('a2', 'w1', 'c1'),
    entry('a1', 'w1', 'c1'),
  ]);

  assert.deepEqual(store.getAllSnapshot().map((item) => item.id), ['a4', 'a3', 'a2']);
});

test('replay tracker deduplicates subscriptions but safely replays after reconnect', () => {
  const tracker = new ConversationReplayTracker();
  assert.equal(tracker.subscriptionCursor('c1'), 0);
  tracker.markSubscribed('c1');
  assert.equal(tracker.subscriptionCursor('c1'), null);

  tracker.resetConnection();
  assert.equal(tracker.subscriptionCursor('c1'), 0);
  tracker.markSubscribed('c1');
  assert.equal(tracker.subscriptionCursor('c1'), null);
});
