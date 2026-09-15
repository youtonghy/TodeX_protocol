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
