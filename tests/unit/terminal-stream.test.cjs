const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalStream, TerminalStreamStore } = require('../../dist/unit/lib/terminalStream.js');

const collect = (stream) => {
  const updates = [];
  stream.subscribe((update) => updates.push(update));
  return updates;
};

test('sequenced output drops duplicates and stops at a gap until attached', () => {
  const stream = new TerminalStream();
  const updates = collect(stream);
  assert.equal(stream.applyOutput('a', 1), 'applied');
  assert.equal(stream.applyOutput('a', 1), 'duplicate');
  assert.equal(stream.applyOutput('b', 2), 'applied');
  assert.equal(stream.applyOutput('d', 4), 'gap');
  assert.equal(stream.applyOutput('e', 5), 'waiting');
  stream.applyAttached({ reset: false, data: 'cde', seq: 5 });
  assert.equal(stream.applyOutput('e', 5), 'duplicate');
  assert.equal(stream.applyOutput('f', 6), 'applied');
  assert.equal(stream.snapshot(), 'abcdef');
  assert.deepEqual(updates.map((update) => update.data), ['a', 'b', 'cde', 'f']);
});

test('a reset attach replaces the output, clear empties it and keeps numbering', () => {
  const stream = new TerminalStream();
  const updates = collect(stream);
  stream.applyOutput('old', 3);
  stream.applyAttached({ reset: true, data: 'tail', seq: 9 });
  assert.equal(stream.snapshot(), 'tail');
  assert.deepEqual(updates.at(-1), { kind: 'reset', data: 'tail' });
  stream.clear();
  assert.equal(stream.snapshot(), '');
  assert.equal(stream.applyOutput('x', 10), 'applied');
  stream.restart();
  assert.equal(stream.applyOutput('new process', 1), 'applied');
});

test('unsequenced output appends and the kept output stays under the limit', () => {
  const stream = new TerminalStream(10);
  stream.append('12345');
  stream.applyOutput('67890');
  stream.append('abc');
  assert.equal(stream.snapshot(), '67890abc');
  assert.equal(stream.truncated, true, 'trimming marks the stream truncated');
  stream.append('x'.repeat(25));
  assert.equal(stream.snapshot().length, 10);
  stream.applyAttached({ reset: true, data: 'screen', seq: 3 });
  assert.equal(stream.truncated, false, 'a reset brings back a whole screen');
});

test('the store creates streams on demand and retains only live terminals', () => {
  const store = new TerminalStreamStore();
  store.get('a').append('1');
  store.get('b').append('2');
  const unsubscribe = store.get('c').subscribe(() => {});
  store.retain(['b']);
  assert.equal(store.peek('a'), undefined);
  assert.equal(store.get('b').snapshot(), '2');
  assert.ok(store.peek('c'), 'a stream a view shows stays');
  unsubscribe();
  store.retain(['b']);
  assert.equal(store.peek('c'), undefined);
});
