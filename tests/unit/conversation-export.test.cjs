const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const exporter = require(path.join(__dirname, '../../dist/unit/lib/conversationExport.js'));

function event(sequence, type, payload = {}, extra = {}) {
  return { schemaVersion: 2, eventId: `event-${sequence}`, conversationId: 'c', sequence,
    time: '2026-10-03T00:00:00.000Z', type, payload, ...extra };
}
const journal = [
  event(1, 'message.created', { role: 'user', content: 'Fix the **build**' }),
  event(2, 'turn.started', { turnId: 't' }),
  event(3, 'message.delta', { text: 'Looking', turnId: 't' }),
  event(4, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
  event(5, 'message.delta', { text: 'Done.', turnId: 't' }),
  event(6, 'turn.completed', { turnId: 't' }),
];
function pagedReplay(pageSize) {
  const calls = [];
  const replay = async (id, after, limit) => {
    calls.push({ id, after, limit });
    const events = journal.filter(item => item.sequence > after).slice(0, pageSize);
    const last = events[events.length - 1]?.sequence ?? after;
    return { conversationId: id, fromSequence: after, nextSequence: last, hasMore: last < journal.length, events };
  };
  return { replay, calls };
}

test('fetches every page and keeps only user and assistant messages', async () => {
  const { replay, calls } = pagedReplay(2);
  const entries = await exporter.fetchConversationTranscript(replay, 'c', 'w');
  assert.deepEqual(calls.map(call => call.after), [0, 2, 4]);
  assert.deepEqual(entries.map(entry => [entry.kind, entry.subtitle]),
    [['outgoing', 'Fix the **build**'], ['incoming', 'Looking'], ['incoming', 'Done.']]);
});

test('reports a journal that stops advancing instead of looping', async () => {
  const replay = async (id, after) => ({ conversationId: id, fromSequence: after, nextSequence: after, hasMore: true, events: [] });
  await assert.rejects(exporter.fetchConversationTranscript(replay, 'c', 'w'), /gap/);
});

test('renders messages under role headings', async () => {
  const entries = await exporter.fetchConversationTranscript(pagedReplay(10).replay, 'c', 'w');
  assert.equal(exporter.conversationTranscriptMarkdown(entries, { title: 'Build fix' }),
    '# Build fix\n\n## User\n\nFix the **build**\n\n## Assistant\n\nLooking\n\n## Assistant\n\nDone.\n');
});

test('drops the oldest messages to fit the byte budget', () => {
  const entries = ['one', 'two', 'three'].map((text, index) =>
    ({ id: String(index), kind: index % 2 ? 'incoming' : 'outgoing', title: '', subtitle: text, raw: '', at: index, sequence: index }));
  const markdown = exporter.conversationTranscriptMarkdown(entries, { title: 'T', maxBytes: 70 });
  assert.ok(new TextEncoder().encode(markdown).length <= 70);
  assert.match(markdown, /earlier message\(s\) omitted/);
  assert.match(markdown, /three/);
  assert.doesNotMatch(markdown, /one/);
});

test('truncates a single message larger than the budget', () => {
  const entries = [{ id: 'a', kind: 'incoming', title: '', subtitle: '界'.repeat(200), raw: '', at: 0, sequence: 1 }];
  const markdown = exporter.conversationTranscriptMarkdown(entries, { title: 'T', maxBytes: 120 });
  assert.ok(new TextEncoder().encode(markdown).length <= 120);
  assert.match(markdown, /## Assistant/);
  assert.doesNotMatch(markdown, /�/);
});
