const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalReplayDelta } = require('../../dist/unit/lib/terminalReplay.js');
const entry = (id, kind, text) => ({ id, kind, text });
test('PTY replay preserves ANSI and skips synthetic input echo', () => {
  const result = terminalReplayDelta([entry('1', 'input', 'ls\n'), entry('2', 'stdout', '\x1b[31mhello'), entry('3', 'stderr', '\x1b[0m')], '');
  assert.equal(result.data, '\x1b[31mhello\x1b[0m');
  assert.equal(result.reset, true);
  assert.equal(result.cursor, '3');
});
test('PTY replay only writes unseen output and does not reset for state changes', () => {
  const output = [entry('1', 'stdout', 'old'), entry('2', 'stdout', '\rnew')];
  assert.deepEqual(terminalReplayDelta(output, '1'), { data: '\rnew', reset: false, cursor: '2' });
  assert.deepEqual(terminalReplayDelta(output, '2'), { data: '', reset: false, cursor: '2' });
});
test('clear and truncated history reset the emulator before replay', () => {
  assert.deepEqual(terminalReplayDelta([], '1'), { data: '', reset: true, cursor: '' });
  assert.deepEqual(terminalReplayDelta([entry('4', 'stdout', 'retained')], '1'), { data: 'retained', reset: true, cursor: '4' });
});
