const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { activeChatProcessId, buildChatRenderItems } = require(path.join(compiledDir, 'lib', 'chatRenderItems.js'));

// Cases from TodeX_web's tests/unit/conversationTimeline.test.ts, where the layout lived first.
const entry = (id, kind, turnId, category) => ({ id, kind, turnId, category, title: id, subtitle: id, raw: '', at: 1, conversationId: 'c' });
const prompt = (id, turnId) => entry(id, 'outgoing', turnId);
const step = (id, turnId, category = 'tool') => entry(id, 'system', turnId, category);
const types = (items) => items.map((item) => item.type);
const ids = (group) => group.entries.map((item) => item.id);

test('omits unattributed startup statuses above the first prompt', () => {
  const items = buildChatRenderItems([step('setup', undefined, 'status'), prompt('u', 't'), step('tool', 't')]);
  assert.deepEqual(types(items), ['entry', 'executionGroup']);
  assert.equal(items[0].entry.id, 'u');
  assert.deepEqual(ids(items[1]), ['tool']);
});

test('puts a single trace after its prompt even when status arrives first', () => {
  const items = buildChatRenderItems([step('status', 't', 'status'), prompt('u', 't'), step('tool', 't')]);
  assert.equal(items.length, 2);
  assert.equal(items[0].entry.id, 'u');
  assert.deepEqual(ids(items[1]), ['status', 'tool']);
  assert.equal(items[1].userMessageId, 'u');
});

test('keeps assistant progress narration visible between traces', () => {
  const items = buildChatRenderItems([prompt('u', 't'), step('toolA', 't'), step('note', 't', 'assistant_progress'), step('toolB', 't')]);
  assert.deepEqual(types(items), ['entry', 'executionGroup', 'entry', 'executionGroup']);
  assert.deepEqual(ids(items[1]), ['toolA']);
  assert.equal(items[2].entry.id, 'note');
  assert.deepEqual(ids(items[3]), ['toolB']);
  assert.notEqual(items[1].id, items[3].id);
});

test('folds summary progress stubs into one trace', () => {
  const stub = { ...step('start', 't', 'assistant_progress'), subtitle: '', detailStub: true };
  const items = buildChatRenderItems([prompt('u', 't'), step('think', 't', 'reasoning'), stub, step('toolA', 't')]);
  assert.deepEqual(types(items), ['entry', 'executionGroup']);
  assert.deepEqual(ids(items[1]), ['think', 'start', 'toolA']);
});

test('interleaves traces with the text they separate', () => {
  const items = buildChatRenderItems([prompt('u', 't'), step('one', 't'), entry('answer', 'incoming', 't'), step('failure', 't', 'error'), step('two', 't')]);
  assert.deepEqual(types(items), ['entry', 'executionGroup', 'entry', 'entry', 'executionGroup']);
  assert.equal(items[3].entry.id, 'failure');
  assert.deepEqual(ids(items[4]), ['two']);
});

test('splits narration into segments around step runs', () => {
  const items = buildChatRenderItems([prompt('u', 't'), entry('seg-a', 'incoming', 't'), step('tool', 't'), entry('seg-b', 'incoming', 't'),
    step('thought', 't', 'reasoning'), entry('seg-c', 'incoming', 't')]);
  assert.deepEqual(types(items), ['entry', 'entry', 'executionGroup', 'entry', 'executionGroup', 'entry']);
});

test('keeps turns separate and does not mark an old turn live for a new prompt', () => {
  const items = buildChatRenderItems([prompt('u1', 't1'), step('one', 't1'), entry('answer', 'incoming', 't1'), prompt('u2', 't2')]);
  assert.equal(activeChatProcessId(items, 't2'), '');
  assert.equal(activeChatProcessId(items, 't1'), '');
  const updated = buildChatRenderItems([prompt('u1', 't1'), step('one', 't1'), prompt('u2', 't2'), step('two', 't2')]);
  const groups = updated.filter((item) => item.type === 'executionGroup');
  assert.equal(new Set(groups.map((item) => item.id)).size, 2);
  assert.equal(activeChatProcessId(updated, 't2'), groups[1].id);
});

test('a group stops being live once the agent replies after it', () => {
  const items = buildChatRenderItems([prompt('u', 't'), step('one', 't'), entry('narration', 'incoming', 't'), step('bg', 't'), entry('waiting', 'incoming', 't')]);
  assert.equal(activeChatProcessId(items, 't'), '');
  const live = buildChatRenderItems([prompt('u', 't'), step('one', 't'), entry('narration', 'incoming', 't'), step('bg', 't')]);
  assert.equal(activeChatProcessId(live, 't'), live[3].id);
});

test('keeps orphan steps when history has no prompt', () => {
  const items = buildChatRenderItems([step('tool', 'old'), step('approval', 'old', 'approval'), prompt('new', 'new')]);
  assert.deepEqual(ids(items[0]), ['tool', 'approval']);
  assert.equal(activeChatProcessId(items, 'new'), '');
});

test('groups legacy entries within their own user-message window', () => {
  const items = buildChatRenderItems([prompt('u1'), step('one'), entry('answer', 'incoming'), step('two'), prompt('u2'), step('three')]);
  const groups = items.filter((item) => item.type === 'executionGroup');
  assert.deepEqual(groups.map(ids), [['one'], ['two'], ['three']]);
  assert.equal(activeChatProcessId(items), groups[2].id);
});

test('keeps turn identity when a step omits its turn id', () => {
  const items = buildChatRenderItems([prompt('u', 't'), step('unattributed'), step('tool', 't')]);
  assert.equal(items.length, 2);
  assert.equal(items[1].turnId, 't');
  assert.deepEqual(ids(items[1]), ['unattributed', 'tool']);
  assert.equal(activeChatProcessId(items, 't'), items[1].id);
});
