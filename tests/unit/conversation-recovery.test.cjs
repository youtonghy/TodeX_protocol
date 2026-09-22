const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ConversationRecovery } = require('../../dist/unit/lib/conversationRecovery.js');
function event(sequence, type, payload = {}) {
  return { schemaVersion: 2, eventId: `e${sequence}`, conversationId: 'c', sequence, time: '2026-09-08T00:00:00Z', type, payload };
}
const started = event(1, 'turn.started', { turnId: 't' });
const delta = (sequence, text) => event(sequence, 'message.delta', { turnId: 't', text });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('recovery buffers out-of-order live events and applies duplicate REST data once', async () => {
  const page = deferred();
  const calls = [];
  const updates = [];
  const recovery = new ConversationRecovery(async (...args) => { calls.push(args); return page.promise; }, (state, applied, recovering) => updates.push({ sequence: state.appliedSequence, applied: applied.map(e => e.sequence), recovering }), error => assert.fail(error));
  recovery.receive('c', 'w', [delta(3, ' world')]);
  assert.equal(recovery.get('c').appliedSequence, 0);
  assert.equal(updates[0].recovering, true);
  const work = recovery.recover('c', 'w');
  assert.equal(recovery.recover('c', 'w'), work);
  await Promise.resolve();
  recovery.receive('c', 'w', [started, delta(2, 'Hello')]);
  page.resolve({ events: [started, delta(2, 'Hello'), delta(3, ' world')], hasMore: false });
  await work;
  assert.deepEqual(calls, [['c', 0, 500]]);
  assert.equal(recovery.get('c').appliedSequence, 3);
  assert.equal(recovery.get('c').timeline[0].subtitle, 'Hello world');
  assert.deepEqual(updates.flatMap(u => u.applied), [1, 2, 3]);
  assert.equal(recovery.isRecovering('c'), false);
});

test('recovery resumes from the contiguous cursor and handles empty conversations', async () => {
  const cursors = [];
  const recovery = new ConversationRecovery(async (_id, cursor) => {
    cursors.push(cursor);
    return cursor === 1 ? { events: [delta(2, 'a')], hasMore: true } : { events: [], hasMore: false };
  }, () => {}, error => assert.fail(error));
  recovery.receive('c', 'w', [started]);
  await recovery.recover('c', 'w');
  assert.deepEqual(cursors, [1, 2]);
  await recovery.recover('empty', 'w');
  assert.equal(recovery.get('empty').appliedSequence, 0);
});

test('non-progressing replay keeps recovery blocked until a successful retry fills gaps', async () => {
  let fixed = false;
  const errors = [];
  const recovery = new ConversationRecovery(async () => ({ events: fixed ? [started, delta(2, 'filled')] : [], hasMore: false }), () => {}, error => errors.push(error));
  recovery.receive('c', 'w', [event(3, 'turn.completed', { turnId: 't' })]);
  await recovery.recover('c', 'w');
  assert.equal(errors.length, 1);
  assert.equal(recovery.isRecovering('c'), true);
  fixed = true;
  await recovery.recover('c', 'w');
  assert.equal(recovery.isRecovering('c'), false);
  assert.equal(recovery.get('c').status, 'completed');
});

test('reset discards in-flight replay from an old backend', async () => {
  const old = deferred();
  const updates = [];
  const recovery = new ConversationRecovery(() => old.promise, state => updates.push(state), error => assert.fail(error));
  const work = recovery.recover('c', 'w');
  await Promise.resolve();
  recovery.reset();
  old.resolve({ events: [started], hasMore: false });
  await work;
  assert.equal(recovery.get('c'), undefined);
  assert.equal(updates.length, 0);
});

test('old turn completion in replay does not clear a newer running turn or approval', async () => {
  const recovery = new ConversationRecovery(async () => ({ events: [event(4, 'turn.failed', { turnId: 'old' })], hasMore: false }), () => {}, error => assert.fail(error));
  recovery.receive('c', 'w', [started, event(2, 'turn.started', { turnId: 'new' }), event(3, 'permission.requested', { turnId: 'new', permissionId: 'approval-new' })]);
  await recovery.recover('c', 'w');
  assert.equal(recovery.get('c').activeTurnId, 'new');
  assert.equal(recovery.get('c').status, 'waitingPermission');
  assert.equal(recovery.get('c').pendingPermissions[0].id, 'approval-new');
});

test('projection callbacks observe the latest committed recovery state', () => {
  const recovery = new ConversationRecovery(async () => ({ events: [], hasMore: false }), state => assert.equal(recovery.get('c'), state), error => assert.fail(error));
  recovery.receive('c', 'w', [started]);
});

/** In-memory journal helpers for the lazy-loading paths: `after` pages move
 * forward, `before` pages return the newest events at or below the cursor. */
const journalStore = (events) => ({
  after: async (_id, afterSequence, limit) => {
    const page = events.filter((entry) => entry.sequence > afterSequence).slice(0, limit);
    return { events: page, hasMore: page.length ? page[page.length - 1].sequence < events[events.length - 1].sequence : false };
  },
  before: async (_id, beforeSequence, limit) => {
    const page = events.filter((entry) => entry.sequence <= beforeSequence).slice(-limit);
    return { events: page, hasMore: page.length ? page[0].sequence > 1 : false };
  },
});

test('lazy open seeds a tail floor and loadEarlier prepends older pages', async () => {
  const journal = [];
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    journal.push(event(sequence, 'message.created', { role: 'user', content: `m${sequence}` }));
  }
  const store = journalStore(journal);
  const forwardCalls = [];
  const recovery = new ConversationRecovery(
    async (id, after, limit) => { forwardCalls.push(after); return store.after(id, after, limit); },
    () => {},
    (error) => assert.fail(error),
    store.before,
  );
  await recovery.open('c', 'w', { highWater: 10, pageLimit: 4 });
  // Only the tail window projected; the forward replay never ran.
  assert.deepEqual(forwardCalls, []);
  let state = recovery.get('c');
  assert.equal(state.appliedSequence, 10);
  assert.deepEqual(state.timeline.map((entry) => entry.sequence), [10, 9, 8, 7]);
  assert.equal(recovery.hasEarlierHistory('c'), true);

  assert.equal(await recovery.loadEarlier('c', 'w', 4), true);
  state = recovery.get('c');
  assert.deepEqual(state.timeline.map((entry) => entry.sequence), [10, 9, 8, 7, 6, 5, 4, 3]);

  assert.equal(await recovery.loadEarlier('c', 'w', 4), false);
  state = recovery.get('c');
  assert.deepEqual(state.timeline.map((entry) => entry.sequence), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(recovery.hasEarlierHistory('c'), false);
  // Exhausted history stops paging.
  assert.equal(await recovery.loadEarlier('c', 'w', 4), false);
});

test('lazy open keeps a racing live frame and drains it after the window', async () => {
  const journal = [];
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    journal.push(event(sequence, 'message.created', { role: 'user', content: `m${sequence}` }));
  }
  const store = journalStore(journal);
  const recovery = new ConversationRecovery(store.after, () => {}, (error) => assert.fail(error), store.before);
  const work = recovery.open('c', 'w', { highWater: 10, pageLimit: 4 });
  // A live frame landing before the seed must not be dropped or trigger a
  // full replay: it buffers above the floor and applies once contiguous.
  recovery.receive('c', 'w', [event(11, 'message.created', { role: 'user', content: 'live' })]);
  await work;
  const state = recovery.get('c');
  assert.equal(state.appliedSequence, 11);
  assert.equal(state.timeline[0].sequence, 11);
  assert.deepEqual(state.timeline.map((entry) => entry.sequence), [11, 10, 9, 8, 7]);
});

test('lazy open pages back until the running turn start is inside the window', async () => {
  const journal = [
    event(1, 'message.created', { role: 'user', content: 'old' }),
    event(2, 'turn.completed', { turnId: 'old' }),
    event(3, 'message.created', { role: 'user', content: 'older' }),
    event(4, 'turn.started', { turnId: 't' }),
    ...[5, 6, 7, 8, 9, 10].map((sequence) => event(sequence, 'message.delta', { turnId: 't', text: `d${sequence}` })),
  ];
  const store = journalStore(journal);
  const recovery = new ConversationRecovery(store.after, () => {}, (error) => assert.fail(error), store.before);
  await recovery.open('c', 'w', { highWater: 10, turnActive: true, pageLimit: 4 });
  const state = recovery.get('c');
  assert.equal(state.appliedSequence, 10);
  assert.equal(state.activeTurnId, 't');
  assert.equal(state.status, 'running');
  // The scan covered sequences 1..10 minus the two oldest events.
  assert.equal(recovery.hasEarlierHistory('c'), true);
});

test('lazy open falls back to a full replay when the backend lacks reverse paging', async () => {
  const journal = [];
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    journal.push(event(sequence, 'message.created', { role: 'user', content: `m${sequence}` }));
  }
  const store = journalStore(journal);
  // An old backend ignores beforeSequence and answers the forward first page.
  const recovery = new ConversationRecovery(store.after, () => {}, (error) => assert.fail(error),
    async (id, _before, limit) => store.after(id, 0, limit));
  await recovery.open('c', 'w', { highWater: 10, pageLimit: 4 });
  const state = recovery.get('c');
  assert.equal(state.appliedSequence, 10);
  assert.equal(state.timeline.length, 10);
  assert.equal(recovery.hasEarlierHistory('c'), false);
});
