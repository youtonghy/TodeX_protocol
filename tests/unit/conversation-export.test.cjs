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

const longJournal = [
  event(1, 'message.created', { role: 'user', content: 'First question' }),
  event(2, 'turn.started', { turnId: 't1' }),
  event(3, 'message.delta', { text: 'Alpha ', turnId: 't1' }),
  event(4, 'message.delta', { text: 'beta ', turnId: 't1' }),
  event(5, 'message.delta', { text: 'gamma.', turnId: 't1' }),
  event(6, 'tool.started', { turnId: 't1', toolCallId: 'x', toolName: 'ls' }),
  event(7, 'message.delta', { text: 'After the tool.', turnId: 't1' }),
  event(8, 'turn.completed', { turnId: 't1' }),
  event(9, 'message.created', { role: 'user', content: 'Second **question**' }),
  event(10, 'turn.started', { turnId: 't2' }),
  event(11, 'message.delta', { text: 'One ', turnId: 't2' }),
  event(12, 'message.delta', { text: 'two ', turnId: 't2' }),
  event(13, 'message.delta', { text: 'three.', turnId: 't2' }),
  event(14, 'turn.completed', { turnId: 't2' }),
  event(15, 'message.created', { role: 'user', content: 'Third' }),
  event(16, 'turn.started', { turnId: 't3' }),
  event(17, 'message.delta', { text: 'Final ', turnId: 't3' }),
  event(18, 'message.delta', { text: 'answer.', turnId: 't3' }),
  event(19, 'turn.completed', { turnId: 't3' }),
];
/** Reverse paging like the backend's `beforeSequence`: the newest `pageSize`
 * events at or below the cursor, ascending. */
function pagedReplayBefore(events, pageSize) {
  const calls = [];
  const replayBefore = async (id, before, limit) => {
    calls.push(before);
    const page = events.filter(item => item.sequence <= before).slice(-Math.min(limit, pageSize));
    const first = page[0]?.sequence ?? 1;
    return { conversationId: id, fromSequence: first - 1, nextSequence: page.at(-1)?.sequence ?? before, hasMore: first > 1, events: page };
  };
  return { replayBefore, calls };
}
function forwardReplay(events) {
  return async (id, after, limit) => {
    const page = events.filter(item => item.sequence > after).slice(0, limit);
    const last = page.at(-1)?.sequence ?? after;
    return { conversationId: id, fromSequence: after, nextSequence: last, hasMore: last < events.length, events: page };
  };
}

test('tail-first export renders exactly what the full replay renders when the budget holds everything', async () => {
  const fullEntries = await exporter.fetchConversationTranscript(forwardReplay(longJournal), 'c', 'w');
  for (const maxBytes of [undefined, 100_000]) {
    const expected = exporter.conversationTranscriptMarkdown(fullEntries, { title: 'Long', maxBytes });
    for (const pageSize of [1, 2, 3, 4, 7, 1000]) {
      const transcript = await exporter.fetchConversationTranscriptTail(pagedReplayBefore(longJournal, pageSize).replayBefore, 'c', 'w', { title: 'Long', maxBytes });
      assert.equal(transcript.olderUnread, false);
      assert.equal(exporter.conversationTranscriptMarkdown(transcript.entries, { title: 'Long', maxBytes, olderUnread: transcript.olderUnread }),
        expected, `page ${pageSize}, budget ${maxBytes}`);
    }
  }
  assert.deepEqual(fullEntries.map(entry => entry.subtitle), ['First question', 'Alpha beta gamma.', 'After the tool.',
    'Second **question**', 'One two three.', 'Third', 'Final answer.']);
});

test('tail-first export stops reading once the newest messages fill the budget', async () => {
  const fullEntries = await exporter.fetchConversationTranscript(forwardReplay(longJournal), 'c', 'w');
  const fullSections = fullEntries.map(entry => `## ${entry.kind === 'outgoing' ? 'User' : 'Assistant'}\n\n${entry.subtitle}\n`);
  let stoppedEarly = 0;
  for (let maxBytes = 40; maxBytes <= 260; maxBytes += 5) {
    const expected = exporter.conversationTranscriptMarkdown(fullEntries, { title: 'Long', maxBytes });
    for (const pageSize of [1, 2, 3, 4]) {
      const { replayBefore, calls } = pagedReplayBefore(longJournal, pageSize);
      const transcript = await exporter.fetchConversationTranscriptTail(replayBefore, 'c', 'w', { title: 'Long', maxBytes });
      const markdown = exporter.conversationTranscriptMarkdown(transcript.entries, { title: 'Long', maxBytes, olderUnread: transcript.olderUnread });
      assert.ok(new TextEncoder().encode(markdown).length <= maxBytes, `page ${pageSize}, budget ${maxBytes}`);
      if (!transcript.olderUnread) {
        assert.equal(markdown, expected, `page ${pageSize}, budget ${maxBytes}`);
        continue;
      }
      stoppedEarly++;
      assert.ok(calls.at(-1) > 1, 'older pages stay unread');
      assert.match(markdown, /^# Long\n\n> Earlier messages omitted\.\n/);
      // Only whole messages, the newest ones, in journal order — or the
      // beginning of the newest one when it alone exceeds the budget.
      const body = markdown.slice('# Long\n\n> Earlier messages omitted.\n\n'.length);
      const wholeTails = fullSections.map((_, index) => fullSections.slice(index).join('\n'));
      assert.ok(wholeTails.includes(body) || fullSections.at(-1).startsWith(body.replace(/\n$/, '')),
        `page ${pageSize}, budget ${maxBytes}: ${JSON.stringify(body)}`);
    }
  }
  assert.ok(stoppedEarly > 0);
});

test('tail-first export leaves out the message still continuing below the pages read', async () => {
  const journal = [
    event(1, 'message.created', { role: 'user', content: 'Q' }),
    event(2, 'turn.started', { turnId: 't' }),
    ...Array.from({ length: 6 }, (_, index) => event(index + 3, 'message.delta', { text: `chunk${index} `, turnId: 't' })),
    event(9, 'turn.completed', { turnId: 't' }),
    event(10, 'message.created', { role: 'user', content: 'Next' }),
  ];
  // The first page (8..10) holds only the tail of the streamed answer.
  const transcript = await exporter.fetchConversationTranscriptTail(pagedReplayBefore(journal, 3).replayBefore, 'c', 'w', { title: 'T', maxBytes: 40 });
  assert.equal(transcript.olderUnread, true);
  assert.deepEqual(transcript.entries.map(entry => entry.subtitle), ['Next']);
});

test('tail-first export refuses a backend that answers with the journal head', async () => {
  const replayBefore = async (id, before, limit) => ({ ...(await forwardReplay(longJournal)(id, 0, Math.min(limit, 3))) });
  await assert.rejects(exporter.fetchConversationTranscriptTail(replayBefore, 'c', 'w', { title: 'T' }), /backwards/);
  const gap = async (id, before) => ({ conversationId: id, fromSequence: 0, nextSequence: 0, hasMore: before > 15,
    events: before > 15 ? longJournal.slice(15) : longJournal.slice(0, 5) });
  await assert.rejects(exporter.fetchConversationTranscriptTail(gap, 'c', 'w', { title: 'T' }), /gap/);
});
