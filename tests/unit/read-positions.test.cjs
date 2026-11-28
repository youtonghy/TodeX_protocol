const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  ReadReporter,
  conversationReadFrame,
  hasUnseenEvents,
  parseConversationReadPosition,
} = require(path.join(lib, 'readPositions.js'));
const { normalizeConversationRecord } = require(path.join(lib, 'mobileParity.js'));

test('read frames, events and the unseen rule', () => {
  assert.deepEqual(conversationReadFrame('c1', 7), { type: 'conversation.read', payload: { conversationId: 'c1', sequence: 7 } });
  assert.deepEqual(conversationReadFrame('c1'), { type: 'conversation.read', payload: { conversationId: 'c1' } });
  assert.throws(() => conversationReadFrame(' '));
  assert.throws(() => conversationReadFrame('c1', -1));
  assert.deepEqual(parseConversationReadPosition({ conversationId: 'c1', readSequence: 3 }), { conversationId: 'c1', readSequence: 3 });
  assert.equal(parseConversationReadPosition({ conversationId: 'c1', readSequence: '3' }), null);
  assert.equal(hasUnseenEvents(5, 4), true);
  assert.equal(hasUnseenEvents(5, 5), false);
  // No position yet: a conversation from before read sync counts as read.
  assert.equal(hasUnseenEvents(5, undefined), false);
});

test('manifests carry their read position into records', () => {
  const base = { id: 'c1', workspaceId: 'w', provider: 'codex', status: 'idle', lastSequence: 9 };
  assert.equal(normalizeConversationRecord({ ...base, readSequence: 4 }).readSequence, 4);
  assert.equal('readSequence' in normalizeConversationRecord(base), false);
});

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimer: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
      }
    },
  };
}

test('the reporter sends at most once per interval, newest position trailing', async () => {
  const clock = fakeClock();
  const sent = [];
  const reporter = new ReadReporter({
    send: async (id, sequence) => { sent.push([id, sequence]); return { conversationId: id, readSequence: sequence }; },
    intervalMs: 1000,
    ...clock,
  });
  reporter.mark('c1', 3);
  assert.deepEqual(sent, [['c1', 3]]);
  reporter.mark('c1', 4);
  reporter.mark('c1', 6);
  reporter.mark('c1', 5);
  assert.equal(sent.length, 1);
  clock.advance(1000);
  assert.deepEqual(sent, [['c1', 3], ['c1', 6]]);
  await Promise.resolve();
  // Known positions are never sent again.
  clock.advance(5000);
  reporter.mark('c1', 6);
  reporter.learn('c2', 10);
  reporter.mark('c2', 9);
  assert.equal(sent.length, 2);
});

test('a position learned from another device cancels a pending send', () => {
  const clock = fakeClock();
  const sent = [];
  const reporter = new ReadReporter({ send: async (id, sequence) => { sent.push([id, sequence]); }, intervalMs: 1000, ...clock });
  reporter.mark('c1', 1);
  reporter.mark('c1', 8);
  reporter.learn('c1', 8);
  clock.advance(1000);
  assert.deepEqual(sent, [['c1', 1]]);
});
