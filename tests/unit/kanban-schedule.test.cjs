const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const todex = require(path.join(compiledDir, 'lib', 'todex.js'));

function task(overrides = {}) {
  return { id: 'task-1', workspaceId: 'ws_1', title: 'Ship', status: 'planned', createdAt: 1, updatedAt: 2, ...overrides };
}

test('kanban schedules survive normalization and malformed ones are dropped', () => {
  const schedule = {
    id: 's1', at: '2026-10-10T09:30', action: 'send', conversationId: 'conv_1', text: 'go',
    status: 'done', firedAt: 5, resultConversationId: 'conv_1', turnId: 'turn_1', model: '',
  };
  assert.deepEqual(todex.normalizeKanbanTask(task({ schedule })).schedule, {
    id: 's1', at: '2026-10-10T09:30', action: 'send', conversationId: 'conv_1', text: 'go',
    status: 'done', firedAt: 5, resultConversationId: 'conv_1', turnId: 'turn_1',
  });
  for (const broken of [
    { ...schedule, at: '2026-10-10 09:30' },
    { ...schedule, action: 'later' },
    { ...schedule, status: 'queued' },
    { ...schedule, conversationId: '' },
    { ...schedule, text: ' ' },
  ]) {
    assert.equal(todex.normalizeKanbanTask(task({ schedule: broken })).schedule, undefined);
  }
});

test('kanban sync payload always carries an explicit conversation list', () => {
  const [bare, linked] = todex.prepareKanbanSyncPayload([
    task(),
    task({ id: 'task-2', conversationIds: ['a', 'b'], backendConnectionId: 'b1' }),
  ]);
  assert.deepEqual(bare.conversationIds, []);
  assert.deepEqual(linked.conversationIds, ['a', 'b']);
  assert.equal(linked.conversationId, 'a');
  assert.equal(linked.backendConnectionId, undefined);
});

test('kanban time zone is parsed from the sync response', () => {
  assert.deepEqual(
    todex.parseKanbanTimeZone({ tasks: [], timeZone: { name: 'Asia/Shanghai', offsetMinutes: 480 } }),
    { name: 'Asia/Shanghai', offsetMinutes: 480 },
  );
  assert.deepEqual(todex.parseKanbanTimeZone({ timeZone: { offsetMinutes: -300 } }), { offsetMinutes: -300 });
  assert.equal(todex.parseKanbanTimeZone({ tasks: [] }), null);
});
