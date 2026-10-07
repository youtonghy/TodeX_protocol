const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { ConversationEventBatcher, scheduleAnimationFrame, FRAME_BACKSTOP_MS } = require(path.join(lib, 'frameBatch.js'));

function manualScheduler() {
  const tasks = [];
  const schedule = (task) => {
    const entry = { task, cancelled: false };
    tasks.push(entry);
    return () => { entry.cancelled = true; };
  };
  const run = () => { for (const entry of tasks.splice(0)) if (!entry.cancelled) entry.task(); };
  return { schedule, run, scheduled: () => tasks.filter((entry) => !entry.cancelled).length };
}

test('events of one frame reach deliver once per conversation, in arrival order', () => {
  const scheduler = manualScheduler();
  const delivered = [];
  const batcher = new ConversationEventBatcher((id, workspace, events) => delivered.push([id, workspace, events]), assert.fail, scheduler.schedule);
  batcher.push('a', 'w', 1);
  batcher.push('b', 'w', 10);
  batcher.push('a', 'w2', 2);
  batcher.push('a', 'w2', 3);
  assert.equal(scheduler.scheduled(), 1);
  assert.equal(batcher.size, 4);
  assert.deepEqual(delivered, []);
  scheduler.run();
  assert.deepEqual(delivered, [['a', 'w2', [1, 2, 3]], ['b', 'w', [10]]]);
  assert.equal(batcher.size, 0);
  batcher.push('a', 'w', 4);
  scheduler.run();
  assert.deepEqual(delivered.at(-1), ['a', 'w', [4]]);
});

test('flush delivers synchronously and cancels the frame; discard drops the buffer', () => {
  const scheduler = manualScheduler();
  const delivered = [];
  const batcher = new ConversationEventBatcher((id, _workspace, events) => delivered.push([id, events]), assert.fail, scheduler.schedule);
  batcher.push('a', 'w', 1);
  batcher.flush();
  assert.deepEqual(delivered, [['a', [1]]]);
  assert.equal(scheduler.scheduled(), 0);
  batcher.flush();
  assert.equal(delivered.length, 1);
  batcher.push('a', 'w', 2);
  batcher.discard();
  scheduler.run();
  assert.equal(delivered.length, 1);
  assert.equal(batcher.size, 0);
});

test('a failing conversation does not hold back the others', () => {
  const scheduler = manualScheduler();
  const delivered = [];
  const errors = [];
  const batcher = new ConversationEventBatcher((id, _workspace, events) => {
    if (id === 'bad') throw new Error('projection failed');
    delivered.push([id, events]);
  }, (error) => errors.push(error.message), scheduler.schedule);
  batcher.push('bad', 'w', 1);
  batcher.push('good', 'w', 2);
  scheduler.run();
  assert.deepEqual(delivered, [['good', [2]]]);
  assert.deepEqual(errors, ['projection failed']);
});

test('events pushed while delivering start the next batch', () => {
  const scheduler = manualScheduler();
  const delivered = [];
  let batcher;
  batcher = new ConversationEventBatcher((id, _workspace, events) => {
    delivered.push([id, events]);
    if (events.includes(1)) batcher.push('a', 'w', 2);
  }, assert.fail, scheduler.schedule);
  batcher.push('a', 'w', 1);
  scheduler.run();
  assert.deepEqual(delivered, [['a', [1]]]);
  scheduler.run();
  assert.deepEqual(delivered, [['a', [1]], ['a', [2]]]);
});

test('the frame scheduler falls back to a timer and backs animation frames up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ran = 0;
  scheduleAnimationFrame(() => { ran += 1; });
  t.mock.timers.tick(15);
  assert.equal(ran, 0);
  t.mock.timers.tick(1);
  assert.equal(ran, 1);

  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  try {
    scheduleAnimationFrame(() => { ran += 1; });
    frames[0]();
    assert.equal(ran, 2);
    t.mock.timers.tick(FRAME_BACKSTOP_MS);
    assert.equal(ran, 2, 'the backstop timer was cleared');
    // A paused page never runs the frame; the backstop flushes once.
    scheduleAnimationFrame(() => { ran += 1; });
    t.mock.timers.tick(FRAME_BACKSTOP_MS);
    assert.equal(ran, 3);
    frames[1]();
    assert.equal(ran, 3);
    const cancel = scheduleAnimationFrame(() => { ran += 1; });
    cancel();
    t.mock.timers.tick(FRAME_BACKSTOP_MS);
    frames[2]();
    assert.equal(ran, 3);
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
