const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { backendWallClockToIso } = require(path.join(lib, 'todex.js'));
const { parseConversationSchedule } = require(path.join(lib, 'v2.js'));
const { conversationScheduleFrame } = require(path.join(lib, 'conversationCommands.js'));

test('backend wall-clock times convert through the backend offset', () => {
  assert.equal(backendWallClockToIso('2026-10-13T09:00', { offsetMinutes: 480 }), '2026-10-13T01:00:00.000Z');
  assert.equal(backendWallClockToIso('2026-10-13T09:00', { offsetMinutes: -300 }), '2026-10-13T14:00:00.000Z');
  assert.equal(backendWallClockToIso('2026-10-13 09:00', { offsetMinutes: 0 }), null);
});

test('conversation schedules parse and frame', () => {
  assert.deepEqual(parseConversationSchedule({ at: '2026-10-13T01:00:00Z' }), { at: '2026-10-13T01:00:00Z' });
  assert.deepEqual(parseConversationSchedule({ at: '2026-10-13T01:00:00Z', interrupted: true }), { at: '2026-10-13T01:00:00Z', interrupted: true });
  assert.equal(parseConversationSchedule({ at: 'soon' }), undefined);
  assert.equal(parseConversationSchedule(null), undefined);
  assert.deepEqual(conversationScheduleFrame('c1', null), { type: 'conversation.schedule', payload: { conversationId: 'c1', at: null } });
  assert.throws(() => conversationScheduleFrame('c1', 'later'));
});
