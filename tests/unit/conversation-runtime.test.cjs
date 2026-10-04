const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const runtime = require(path.join(__dirname, '../../dist/unit/lib/conversationRuntime.js'));
const parity = require(path.join(__dirname, '../../dist/unit/lib/mobileParity.js'));
function event(sequence, type, payload = {}, extra = {}) {
  return { schemaVersion: 2, eventId: `event-${sequence}`, conversationId: 'c', sequence,
    time: '2026-09-06T00:00:00.000Z', type, payload, ...extra };
}
function empty() { return runtime.createConversationRuntime('c', 'w'); }
function apply(state, ...events) { return runtime.applyConversationRuntimeEvents(state, events); }

test('live/replay interleaving buffers gaps and applies each delta exactly once', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'Hello', turnId: 't' }, { normalizedType: 'assistant.delta' }),
    event(3, 'message.delta', { text: ' world', turnId: 't' }, { normalizedType: 'assistant.delta' }),
    event(4, 'turn.completed', { turnId: 't' })];
  let update = apply(empty(), events[2], events[3]);
  assert.equal(update.state.appliedSequence, 0);
  assert.deepEqual(update.missingSequences, [1, 2]);
  update = apply(update.state, events[0], events[1]);
  assert.equal(update.appliedEvents.length, 4);
  assert.equal(update.state.appliedSequence, 4);
  assert.equal(update.state.timeline.length, 1);
  assert.equal(update.state.timeline[0].subtitle, 'Hello world');
  const duplicate = apply(update.state, ...events);
  assert.equal(duplicate.appliedEvents.length, 0);
  assert.deepEqual(duplicate.state.timeline, apply(empty(), ...events).state.timeline);
  assert.equal(duplicate.state.status, 'completed');
});

test('assistant narration splits into segments around intervening steps', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'First. ', turnId: 't' }),
    event(3, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
    event(4, 'message.delta', { text: 'Second.', turnId: 't' }),
    event(5, 'message.delta', { text: ' more', turnId: 't' }),
    event(6, 'turn.completed', { turnId: 't' })).state;
  const incoming = state.timeline.filter(e => e.kind === 'incoming');
  assert.equal(incoming.length, 2);
  assert.equal(incoming[0].subtitle, 'Second. more');
  assert.equal(incoming[1].subtitle, 'First. ');
  assert.equal(state.status, 'completed');
});

test('contiguous narration without intervening steps stays one entry', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'Hello', turnId: 't' }),
    event(3, 'message.delta', { text: ' world', turnId: 't' }),
    event(4, 'turn.completed', { turnId: 't' })).state;
  assert.equal(state.timeline.filter(e => e.kind === 'incoming').length, 1);
  assert.equal(state.timeline[0].subtitle, 'Hello world');
});

/** Full replay versus a lazy window seeded at `floor` whose older history
 * pages in `pageSize` events at a time. */
function lazyProjection(events, floor, pageSize) {
  let state = apply(runtime.createConversationRuntime('c', 'w', floor), ...events.filter(item => item.sequence > floor)).state;
  for (let top = floor; top > 0; top -= pageSize) {
    state = runtime.prependConversationRuntimeEvents(state, events.filter(item => item.sequence <= top && item.sequence > top - pageSize));
  }
  return state;
}
function rows(state) {
  return state.timeline.slice().sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map(({ id, kind, title, subtitle, category, phase, sequence, firstSequence }) => ({ id, kind, title, subtitle, category, phase, sequence, firstSequence }));
}
function assertLazyMatchesFullReplay(events) {
  const full = rows(apply(empty(), ...events).state);
  const last = events[events.length - 1].sequence;
  for (let floor = 1; floor < last; floor++) {
    for (const pageSize of [1, 2, 3, 300]) {
      assert.deepEqual(rows(lazyProjection(events, floor, pageSize)), full, `floor ${floor}, page ${pageSize}`);
    }
  }
  return full;
}

test('paging history under a lazy window rebuilds interleaved assistant segments', () => {
  const full = assertLazyMatchesFullReplay([event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'First', turnId: 't' }),
    event(3, 'message.delta', { text: ' part. ', turnId: 't' }),
    event(4, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
    event(5, 'tool.completed', { turnId: 't', toolCallId: 'x', result: 'a.txt' }),
    event(6, 'message.delta', { text: 'Second', turnId: 't' }),
    event(7, 'message.delta', { text: ' part.', turnId: 't' }),
    event(8, 'tool.started', { turnId: 't', toolCallId: 'y', toolName: 'cat' }),
    event(9, 'message.delta', { text: 'Third.', turnId: 't' }),
    event(10, 'tool.completed', { turnId: 't', toolCallId: 'y', result: 'body' }),
    event(11, 'message.delta', { text: 'Done.', turnId: 't' }),
    event(12, 'turn.completed', { turnId: 't' })]);
  assert.deepEqual(full.filter(row => row.kind === 'incoming').map(row => [row.id, row.subtitle]), [
    ['v2-assistant-c-t#s2', 'First part. '], ['v2-assistant-c-t#s6', 'Second part.'],
    ['v2-assistant-c-t#s9', 'Third.'], ['v2-assistant-c-t#s11', 'Done.']]);
});

test('paging history rebuilds reasoning streams and tool calls spanning the floor', () => {
  const reasoning = (sequence, thinking) => event(sequence, 'provider.event', { turnId: 't', thinking,
    block: { id: 'r1', category: 'reasoning', phase: 'delta', turnId: 't' } });
  const tool = (sequence, phase, extra) => event(sequence, 'provider.event', { turnId: 't', toolCallId: 'b1', toolName: 'shell',
    block: { id: 'b1', category: 'tool', phase, turnId: 't' }, ...extra });
  const full = assertLazyMatchesFullReplay([event(1, 'turn.started', { turnId: 't' }),
    event(2, 'thought.delta', { turnId: 't', thinking: 'plan ' }),
    event(3, 'thought.delta', { turnId: 't', thinking: 'more ' }),
    event(4, 'thought.delta', { turnId: 't', thinking: 'done' }),
    reasoning(5, 'r2 '), reasoning(6, 'r3 '), reasoning(7, 'r4'),
    event(8, 'tool.started', { turnId: 't', toolCallId: 'z', toolName: 'grep', arguments: { q: 'x' } }),
    event(9, 'message.delta', { text: 'Searching', turnId: 't' }),
    event(10, 'tool.completed', { turnId: 't', toolCallId: 'z', result: 'hit' }),
    tool(11, 'started', { arguments: { cmd: 'ls' } }),
    tool(12, 'completed', { result: 'files' }),
    event(13, 'turn.completed', { turnId: 't' })]);
  assert.equal(full.find(row => row.id === 'v2-thought-c-t').subtitle, 'plan more done');
  assert.equal(full.find(row => row.category === 'reasoning').subtitle, 'r2 r3 r4');
  assert.ok(full.find(row => row.id === 'v2-tool-c-t-z').subtitle.includes('hit'));
  assert.ok(full.find(row => row.category === 'tool').subtitle.includes('files'));
});

test('a live stream continues the assistant segment joined from older history', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'Hel', turnId: 't' }),
    event(3, 'message.delta', { text: 'lo', turnId: 't' })];
  const lazy = apply(lazyProjection(events, 2, 1), event(4, 'message.delta', { text: '!', turnId: 't' })).state;
  assert.deepEqual(lazy.timeline.map(row => [row.id, row.subtitle]), [['v2-assistant-c-t#s2', 'Hello!']]);
  const quiet = apply(lazyProjection([...events, event(4, 'usage.updated', { turnId: 't' })], 3, 300),
    event(5, 'message.delta', { text: '?', turnId: 't' })).state;
  assert.deepEqual(quiet.timeline.map(row => [row.id, row.subtitle]), [['v2-assistant-c-t#s2', 'Hello?']]);
});

test('historical mislabelled message completion cannot end a running turn', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.completed', { turnId: 't', role: 'assistant', text: 'Answer' }, { normalizedType: 'turn.completed' }));
  assert.equal(update.state.activeTurnId, 't');
  assert.equal(update.state.status, 'running');
  assert.equal(update.state.timeline[0].subtitle, 'Answer');
});

test('old turn failure cannot clear a newer active turn or its permission', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 'new' }),
    event(2, 'permission.requested', { turnId: 'new', permissionId: 'p' }),
    event(3, 'turn.failed', { turnId: 'old' }));
  assert.equal(update.state.activeTurnId, 'new');
  assert.equal(update.state.status, 'waitingPermission');
  assert.equal(update.state.pendingPermissions.length, 1);
});

test('permission projection restores only unresolved requests and closes them on terminal event', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'permission.requested', { turnId: 't', permissionId: 'p', options: ['allow', 'deny'] }),
    event(3, 'permission.resolved', { permissionId: 'p' }),
    event(4, 'permission.requested', { turnId: 't', permissionId: 'q' }));
  assert.deepEqual(update.state.pendingPermissions.map(p => p.id), ['q']);
  const completed = apply(update.state, event(5, 'turn.cancelled', { turnId: 't' }));
  assert.deepEqual(completed.state.pendingPermissions, []);
});

function usage(sequence, turnId, cumulative, last = cumulative) {
  return event(sequence, 'usage.updated', { provider: 'codex', turnId, usage: { cumulative, last }, contextWindow: 100 });
}
test('cumulative usage uses turn attribution and repeated snapshots never double count cache', () => {
  const first = { input: 40, output: 10, cacheRead: 20, total: 50 };
  let update = apply(empty(), event(1, 'turn.started', { turnId: 'a' }), usage(2, 'a', first), usage(3, 'a', first),
    event(4, 'turn.completed', { turnId: 'a' }), event(5, 'turn.started', { turnId: 'b' }),
    usage(6, 'b', { input: 100, output: 30, cacheRead: 60, total: 130 }));
  const a = update.state.usageRecords.find(r => r.turnId === 'a');
  const b = update.state.usageRecords.find(r => r.turnId === 'b');
  assert.equal(a.totalTokens, 50);
  assert.equal(b.totalTokens, 80);
  assert.equal(runtime.usageTotalTokens(a), 50);
  assert.equal(runtime.usageTotalTokens(b), 80);
  assert.equal(a.cachedInputTokens, 20);
  assert.equal(b.cachedInputTokens, 40);
  assert.deepEqual(parity.normalizeUsageRecords(update.state.usageRecords), update.state.usageRecords);
});

test('usage updates do not erase running or failed compaction, auxiliary replay retains identity', () => {
  const events = [event(1, 'compaction.started'), usage(2, '', { input: 80, output: 10, total: 90 }),
    event(3, 'subagent.started', { subagentId: 's', title: 'Worker', task: 'Review' }),
    event(4, 'subagent.completed', { subagentId: 's', result: 'Done' }),
    event(5, 'memory.created', { memoryId: 'm', content: 'Fact' })];
  let update = apply(empty(), ...events);
  assert.equal(update.state.compaction.status, 'running');
  assert.equal(update.state.compaction.recommended, true);
  assert.equal(update.state.subagents.length, 1);
  assert.equal(update.state.subagents[0].title, 'Worker');
  assert.equal(update.state.subagents[0].status, 'completed');
  update = apply(update.state, event(6, 'compaction.failed', { message: 'failed' }), usage(7, '', { input: 90, output: 10, total: 100 }), event(8, 'memory.deleted', { memoryId: 'm' }));
  assert.equal(update.state.compaction.status, 'failed');
  assert.equal(update.state.memoryEntries.length, 0);
});

test('subagent metadata and usage persist across events that omit them', () => {
  const state = apply(empty(),
    event(1, 'subagent.started', { subagentId: 's', title: 'Worker', task: 'Review' }),
    event(2, 'subagent.updated', { subagentId: 's', status: 'running',
      metadata: { taskId: 'a3077749', description: 'Running vitest', usage: { total_tokens: 2400 } } }),
    event(3, 'subagent.completed', { subagentId: 's', result: 'Done' })).state;
  const run = state.subagents[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'Done');
  assert.deepEqual(run.usage, { total_tokens: 2400 });
  assert.equal(run.metadata.taskId, 'a3077749');
});

test('a subagent run whose start pages in below the lazy window fills its placeholders', () => {
  const events = [
    event(1, 'turn.started', { turnId: 't' }),
    event(2, 'subagent.started', { subagentId: 'toolu_1', title: 'Restore Package.resolved',
      task: 'run the envelope test', agentKind: 'general-purpose', turnId: 't' }, { time: '2026-09-06T00:00:02.000Z' }),
    event(3, 'subagent.completed', { subagentId: 'toolu_0', title: 'Earlier run', task: 'old task', result: 'ok' }),
    event(4, 'subagent.updated', { subagentId: 'toolu_1', status: 'running',
      metadata: { taskId: 'a3077749', description: 'Running vitest', toolName: 'Bash', usage: { total_tokens: 2400 } } }),
  ];
  // The lazy window opens at floor 3 with only the progress frame loaded.
  let state = apply(runtime.createConversationRuntime('c', 'w', 3), events[3]).state;
  assert.equal(state.subagents.length, 1);
  const orphan = state.subagents[0];
  assert.equal(orphan.status, 'running');
  assert.deepEqual(orphan.usage, { total_tokens: 2400 });
  // Paging in the page holding `subagent.started` heals the placeholder.
  state = runtime.prependConversationRuntimeEvents(state, events.filter(item => item.sequence <= 3));
  assert.equal(state.subagents.length, 2);
  const run = state.subagents.find(item => item.id === 'toolu_1');
  assert.equal(run.title, 'Restore Package.resolved');
  assert.equal(run.task, 'run the envelope test');
  assert.equal(run.agentKind, 'general-purpose');
  assert.equal(run.status, 'running');
  assert.equal(run.startedAt, events[1].time);
  assert.equal(run.metadata.description, 'Running vitest');
  const settled = state.subagents.find(item => item.id === 'toolu_0');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.result, 'ok');
});

test('events from another conversation never enter the projection', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 'x' }, { conversationId: 'other' }));
  assert.equal(update.state.appliedSequence, 0);
  assert.deepEqual(update.appliedEvents, []);
});


test('semantic deltas preserve whitespace and share stable block identity with completion', () => {
  const block = { id: 'item', category: 'assistant_final', phase: 'delta', turnId: 't' };
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.delta', { text: 'Hello', block }),
    event(3, 'message.delta', { text: ' ', block }),
    event(4, 'message.delta', { text: 'world', block }));
  assert.equal(update.state.timeline[0].subtitle, 'Hello world');
  const completed = apply(update.state, event(5, 'message.completed', {
    message: { role: 'assistant', content: 'Hello world' }, block: { ...block, phase: 'completed' },
  }, { normalizedType: 'turn.completed' }));
  assert.equal(completed.state.timeline.length, 1);
  assert.equal(completed.state.timeline[0].subtitle, 'Hello world');
  assert.equal(completed.state.activeTurnId, 't');
});

test('event IDs resembling object properties are treated as ordinary IDs', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }, { eventId: 'toString' }));
  assert.equal(update.state.activeTurnId, 't');
});


test('interrupted lifecycle remains distinct from cancellation and closes its permissions', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'permission.requested', { turnId: 't', permissionId: 'p' }),
    event(3, 'conversation.interrupted', { turnId: 't' }));
  assert.equal(update.state.activeTurnId, '');
  assert.equal(update.state.status, 'interrupted');
  assert.deepEqual(update.state.pendingPermissions, []);
});


test('abort-turn permission round-trips only when advertised by the server', () => {
  const todex = require(path.join(__dirname, '../../dist/unit/lib/todex.js'));
  const request = (options) => todex.classifyPendingRequest({ type: 'conversation.permission.request',
    payload: { requestId: 'p', permissionId: 'p', ...(options ? { options } : {}) } });
  const options = [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    { optionId: 'abort_turn', name: 'Reject and stop', kind: 'abort_turn' }];
  const actions = todex.permissionActions(request(options));
  assert.equal(actions.length, 2);
  assert.deepEqual(todex.permissionDecision(actions[1]), { outcome: 'abort_turn', optionId: 'abort_turn' });
  assert.deepEqual(todex.permissionActions(request()), [true, false]);
  assert.deepEqual(todex.permissionActions(request(options.slice(0, 1))), options.slice(0, 1));
});


test('configuration separates local validation from provider confirmation and resets each turn', () => {
  let update = apply(empty(), event(1, 'turn.started', { turnId: 'a',
    requestedPermissions: { sandboxMode: 'read-only' }, effectivePermissions: { sandboxMode: 'read-only' },
    configurationStatus: 'validated' }));
  assert.equal(update.state.configurationStatus, 'validated');
  assert.equal(update.state.effectiveConfig.source, 'locally-validated');
  update = apply(update.state, event(2, 'turn.configuration', { turnId: 'a', requested: { sandboxMode: 'read-only' },
    effective: { sandboxMode: 'read-only', source: 'provider-confirmed' } }));
  assert.equal(update.state.configurationStatus, 'provider-confirmed');
  assert.equal(update.state.requestedConfig.sandboxMode, 'read-only');
  update = apply(update.state, event(3, 'turn.completed', { turnId: 'a' }), event(4, 'turn.started', { turnId: 'b' }),
    event(5, 'turn.configuration', { turnId: 'a', effective: { sandboxMode: 'danger-full-access', source: 'provider-confirmed' } }));
  assert.equal(update.state.configurationStatus, 'unknown');
  assert.equal(update.state.effectiveConfig, null);
});


test('automatic compaction completion never ends the parent turn', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'compaction.started', { turnId: 't', source: 'provider' }),
    event(3, 'compaction.completed', { turnId: 't', source: 'provider' }));
  assert.equal(update.state.activeTurnId, 't');
  assert.equal(update.state.status, 'running');
  assert.equal(update.state.compaction.status, 'completed');
});

test('socket reconnect cannot acknowledge failed projection or later queued events', async () => {
  const { V2ConversationSocket } = require(path.join(__dirname, '../../dist/unit/lib/v2.js'));
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const errors = [];
  let fail = true;
  const applied = [];
  const client = new V2ConversationSocket({ serverUrl: 'http://127.0.0.1:7345', WebSocketImpl: FakeSocket,
    onEvent: async (event) => { if (fail) throw new Error('projection failed'); applied.push(event.sequence); },
    onError: (error) => errors.push(error.message),
  });
  const deliver = (socket, sequence) => socket.onmessage({ data: JSON.stringify({ type: 'conversation.event', payload: event(sequence, 'turn.started', { turnId: 't' }) }) });
  try {
    client.connect(); sockets[0].onopen(); client.subscribe('c', 0);
    deliver(sockets[0], 1); deliver(sockets[0], 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, ['projection failed']);
    client.connect(); sockets[1].onopen();
    assert.equal(sockets[1].sent[0].payload.afterSequence, 0);
    fail = false;
    deliver(sockets[1], 1); deliver(sockets[1], 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(applied, [1, 2]);
    client.connect(); sockets[2].onopen();
    assert.equal(sockets[2].sent[0].payload.afterSequence, 2);
  } finally { client.close(); }
});


test('flat Claude turn usage includes separate cache input and replaces snapshots', () => {
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'usage.updated', { provider: 'claude-code', scope: 'turn', turnId: 't',
      usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }),
    event(3, 'usage.updated', { provider: 'claude-code', scope: 'turn', turnId: 't',
      usage: { input_tokens: 40, output_tokens: 15, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } }));
  assert.equal(update.state.usageRecords.length, 1);
  assert.equal(update.state.usageRecords[0].cachedInputTokens, 20);
  assert.equal(runtime.usageTotalTokens(update.state.usageRecords[0]), 80);
});

test('Pi usage tracks distinct messages and final completion replaces its matching snapshot', () => {
  const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 };
  const update = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'usage.updated', { provider: 'pi', scope: 'message', turnId: 't', messageId: 'm1', usage }),
    event(3, 'usage.updated', { provider: 'pi', scope: 'message', turnId: 't', messageId: 'm2', usage }),
    event(4, 'message.completed', { provider: 'pi', role: 'assistant',
      message: { role: 'assistant', content: 'Done', usage },
      block: { id: 'm2', turnId: 't', category: 'assistant_final', phase: 'completed' } }));
  assert.equal(update.state.usageRecords.length, 2);
  assert.equal(update.state.usageRecords.reduce((sum, record) => sum + runtime.usageTotalTokens(record), 0), 40);
  assert.ok(update.state.usageRecords.every(record => record.turnId === 't'));
});

test('repeated delivery after a long journal is a projection no-op', () => {
  let state = empty();
  const events = Array.from({ length: 8000 }, (_, index) => event(index + 1, 'provider.event'));
  for (const item of events) state = apply(state, item).state;
  const replay = apply(state, ...events);
  assert.equal(replay.state, state);
  assert.deepEqual(replay.appliedEvents, []);
  assert.equal(replay.state.appliedSequence, 8000);
});

test('final turn usage replaces all early request snapshots without losing prior turns', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }),
    event(2, 'usage.updated', { provider: 'grok-build', turnId: 'old', usage: { last: { input: 4, output: 1 } } }),
    event(3, 'usage.updated', { provider: 'grok-build', turnId: 't', requestId: 'r1', usage: { last: { input: 10, output: 2 } } }),
    event(4, 'usage.updated', { provider: 'grok-build', turnId: 't', requestId: 'r2', usage: { last: { input: 20, output: 3 } } }),
    event(5, 'usage.updated', { provider: 'grok-build', turnId: 't', scope: 'turn', aggregation: 'snapshot', final: true,
      usage: { cacheSemantics: 'included', last: { input: 30, output: 5, cacheRead: 10, total: 35 } } })];
  const state = apply(empty(), ...events).state;
  assert.equal(state.usageRecords.length, 2);
  assert.equal(state.usageRecords.reduce((sum, record) => sum + runtime.usageTotalTokens(record), 0), 40);
  assert.deepEqual(apply(state, ...events).state.usageRecords, state.usageRecords);
});

test('commentary deltas preserve their started phase and stay visible in progress', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.started', { turnId: 't', block: { id: 'm', category: 'assistant_progress', phase: 'started', text: '' } }),
    event(3, 'message.delta', { turnId: 't', block: { id: 'm', category: 'assistant_final', phase: 'delta', text: 'Checking files' }, text: 'Checking files' })).state;
  const progress = state.timeline.find(entry => entry.category === 'assistant_progress');
  assert.ok(progress);
  assert.equal(parity.isStepProgressEntry(progress), true);
  assert.equal(state.timeline.some(entry => entry.kind === 'assistant'), false);
});

test('configuration requires provider readback and failures preserve last effective value', () => {
  let state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'turn.configuration', { turnId: 't', effective: { model: 'old', source: 'provider-confirmed' } }),
    event(3, 'control.requested', { turnId: 't', requestId: 'r', control: { action: 'configure', model: 'new' } }),
    event(4, 'control.completed', { turnId: 't', requestId: 'r', result: {} })).state;
  assert.equal(state.effectiveConfig.model, 'old'); assert.equal(state.configurationStatus, 'unknown');
  state = apply(state, event(5, 'control.unknown', { turnId: 't', requestId: 'r', message: 'ACK lost' })).state;
  assert.equal(state.effectiveConfig.model, 'old'); assert.equal(state.configurationStatus, 'unknown');
  state = apply(state, event(6, 'turn.configuration', { turnId: 't', effective: { model: 'new', source: 'provider-confirmed' } })).state;
  assert.equal(state.effectiveConfig.model, 'new'); assert.equal(state.configurationStatus, 'provider-confirmed');
});

test('native queue snapshots replay deterministically and failures pause pending entries', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }),
    event(2, 'queue.updated', { turnId: 't', items: [{ id: 'q', text: 'Next', status: 'delivering' }] }),
    event(3, 'turn.failed', { turnId: 't' })];
  const state = apply(empty(), ...events).state;
  assert.equal(state.queueItems[0].status, 'delivering'); assert.equal(state.queuePaused, true);
  assert.deepEqual(apply(state, ...events).state.queueItems, state.queueItems);
});

test('summary stubs keep folded entries and hydrate fills content by id', () => {
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'provider.event', { turnId: 't', detailStub: true,
      block: { id: 'call-1', category: 'tool', phase: 'completed', turnId: 't' },
      toolCallId: 'call-1', toolName: 'shell' }),
    event(3, 'provider.event', { turnId: 't', detailStub: true,
      block: { id: 'think-1', category: 'reasoning', phase: 'completed', turnId: 't' } }),
    event(4, 'message.delta', { turnId: 't', text: 'Answer' }),
    event(5, 'turn.completed', { turnId: 't' })).state;
  const toolStub = stubbed.timeline.find(entry => entry.category === 'tool');
  const thinkStub = stubbed.timeline.find(entry => entry.category === 'reasoning');
  assert.ok(toolStub?.detailStub && thinkStub?.detailStub);
  assert.equal(stubbed.appliedSequence, 5);
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, [
    event(3, 'provider.event', { turnId: 't', thinking: 'deep thought',
      block: { id: 'think-1', category: 'reasoning', phase: 'completed', turnId: 't' } }),
    event(2, 'provider.event', { turnId: 't',
      block: { id: 'call-1', category: 'tool', phase: 'completed', turnId: 't' },
      toolCallId: 'call-1', result: 'file list' }),
  ]);
  const tool = hydrated.timeline.find(entry => entry.id === toolStub.id);
  const think = hydrated.timeline.find(entry => entry.id === thinkStub.id);
  assert.equal(tool.detailStub, undefined);
  assert.ok(tool.subtitle.includes('file list'));
  assert.equal(think.detailStub, undefined);
  assert.equal(think.subtitle, 'deep thought');
  assert.equal(hydrated.appliedSequence, 5);
  assert.equal(hydrated.timeline.find(entry => entry.kind === 'incoming').subtitle, 'Answer');
});

test('a folded row built from several summary stubs spans their whole range', () => {
  const reasoning = (sequence, thinking, stub) => event(sequence, 'provider.event', { turnId: 't',
    ...(stub ? { detailStub: true } : { thinking }), block: { id: 'r1', category: 'reasoning', phase: 'delta', turnId: 't' } });
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    reasoning(2, '', true), reasoning(3, '', true), reasoning(4, '', true),
    event(5, 'message.delta', { turnId: 't', text: 'Answer' })).state;
  const stub = stubbed.timeline.find(entry => entry.category === 'reasoning');
  assert.equal(stub.detailStub, true);
  assert.equal(stub.firstSequence, 2);
  assert.equal(stub.sequence, 4);
  const range = [reasoning(2, 'r2 '), reasoning(3, 'r3 '), reasoning(4, 'r4 ')]
    .filter(item => item.sequence >= stub.firstSequence && item.sequence <= stub.sequence);
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, range);
  const row = hydrated.timeline.find(entry => entry.category === 'reasoning');
  assert.equal(row.detailStub, undefined);
  assert.equal(row.subtitle, 'r2 r3 r4 ');
  assert.deepEqual([row.firstSequence, row.sequence], [2, 4]);
});

test('heuristic stubs reuse the full event entry id', () => {
  const stubTool = parity.classifyV2ConversationEvent(event(7, 'provider.event',
    { turnId: 't', detailStub: true, toolCallId: 'c1', toolCall: { id: 'c1', name: 'ls' } }), 'w');
  const fullTool = parity.classifyV2ConversationEvent(event(7, 'provider.event',
    { turnId: 't', toolCallId: 'c1', toolCall: { id: 'c1', name: 'ls' }, result: 'ok' }), 'w');
  assert.equal(stubTool.category, 'tool');
  assert.equal(stubTool.detailStub, true);
  assert.equal(stubTool.id, fullTool.id);
  const stubThought = parity.classifyV2ConversationEvent(event(8, 'provider.event',
    { turnId: 't', detailStub: true }), 'w');
  const fullThought = parity.classifyV2ConversationEvent(event(8, 'provider.event',
    { turnId: 't', reasoning: 'chain' }), 'w');
  assert.equal(stubThought.id, fullThought.id);
});

test('hydrate merges stubs whose ids depend on replay-time turn context', () => {
  // Heuristic events without an explicit turnId bind their entry id to the
  // active turn; a partial detail range has no turn.started to rebuild it.
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'tool.completed', { detailStub: true, toolCallId: 'c1', toolCall: { id: 'c1', name: 'shell' } }),
    event(3, 'reasoning.delta', { detailStub: true }),
    event(4, 'message.delta', { turnId: 't', text: 'Answer' }),
    event(5, 'turn.completed', { turnId: 't' })).state;
  const toolStub = stubbed.timeline.find(entry => entry.id === 'v2-tool-c-t-c1');
  const thinkStub = stubbed.timeline.find(entry => entry.id === 'v2-thought-c-t');
  assert.ok(toolStub?.detailStub && thinkStub?.detailStub);
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, [
    event(2, 'tool.completed', { toolCallId: 'c1', toolCall: { id: 'c1', name: 'shell' }, result: 'ok' }),
    event(3, 'reasoning.delta', { thinking: 'hmm' }),
  ]);
  assert.equal(hydrated.timeline.some(entry => entry.detailStub), false);
  assert.equal(hydrated.timeline.filter(entry => entry.title === '工具调用').length, 1);
  assert.equal(hydrated.timeline.filter(entry => entry.title === '思考中').length, 1);
  const tool = hydrated.timeline.find(entry => entry.title === '工具调用');
  assert.equal(tool.detailStub, undefined);
  assert.ok(tool.subtitle.includes('shell'));
  const think = hydrated.timeline.find(entry => entry.title === '思考中');
  assert.equal(think.subtitle, 'hmm');
});

test('hydrate drops covered stubs that project to no content row', () => {
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'provider.event', { turnId: 't', detailStub: true,
      block: { id: 'think-1', category: 'reasoning', phase: 'started', turnId: 't' } }),
    event(3, 'turn.completed', { turnId: 't' })).state;
  assert.equal(stubbed.timeline.filter(entry => entry.detailStub).length, 1);
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, [
    event(2, 'provider.event', { turnId: 't', delta: { type: 'thinking_start' },
      block: { id: 'think-1', category: 'reasoning', phase: 'started', turnId: 't' } }),
  ]);
  assert.notEqual(hydrated, stubbed);
  assert.equal(hydrated.timeline.some(entry => entry.detailStub), false);
});

test('hydrate never downgrades a row the full stream already advanced', () => {
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'provider.event', { turnId: 't', detailStub: true,
      block: { id: 'call-1', category: 'tool', phase: 'started', turnId: 't' },
      toolCallId: 'call-1', toolName: 'shell' }),
    event(3, 'provider.event', { turnId: 't',
      block: { id: 'call-1', category: 'tool', phase: 'completed', turnId: 't' },
      toolCallId: 'call-1', result: 'RESULT' }),
    event(4, 'turn.completed', { turnId: 't' })).state;
  const entry = stubbed.timeline.find(item => item.category === 'tool');
  assert.equal(entry.detailStub, undefined);
  assert.ok(entry.subtitle.includes('RESULT'));
  // The non-stubbed completed phase sits outside the fetched stub cluster.
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, [
    event(2, 'provider.event', { turnId: 't',
      block: { id: 'call-1', category: 'tool', phase: 'started', turnId: 't' },
      toolCallId: 'call-1', toolName: 'shell', arguments: { cmd: 'ls' } }),
  ]);
  const kept = hydrated.timeline.find(item => item.category === 'tool');
  assert.ok(kept.subtitle.includes('RESULT'));
});

test('hydrate returns the same state when the range covers nothing', () => {
  const stubbed = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'provider.event', { turnId: 't', detailStub: true,
      block: { id: 'call-1', category: 'tool', phase: 'completed', turnId: 't' }, toolCallId: 'call-1' }),
    event(3, 'turn.completed', { turnId: 't' })).state;
  const hydrated = runtime.hydrateConversationRuntimeEvents(stubbed, [
    event(3, 'turn.completed', { turnId: 't' }),
  ]);
  assert.equal(hydrated, stubbed);
});

function piProgress(sequence, text) {
  return event(sequence, 'message.delta', { provider: 'pi', turnId: 't',
    delta: { type: 'text_delta', contentIndex: 1, delta: text },
    block: { category: 'assistant_progress', id: 'm-1-assistant_progress-1', turnId: 't', phase: 'delta', contentIndex: 1 } });
}
function piFinal(sequence, supersedes) {
  return event(sequence, 'message.completed', { provider: 'pi', turnId: 't', role: 'assistant',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }] },
    block: { category: 'assistant_final', id: 'native-1', turnId: 't', phase: 'completed',
      ...(supersedes ? { supersedes } : {}) } });
}

test('final answer replaces the progress rows it was streamed under', () => {
  const streamed = apply(empty(), event(1, 'turn.started', { turnId: 't' }), piProgress(2, 'Ans'), piProgress(3, 'wer'));
  assert.deepEqual(streamed.state.timeline.map((entry) => [entry.category, entry.subtitle]), [['assistant_progress', 'Answer']]);
  const final = apply(streamed.state, piFinal(4, ['m-1-assistant_progress-1']));
  assert.deepEqual(final.state.timeline.map((entry) => [entry.category, entry.subtitle]), [['assistant_final', 'Answer']]);
  // Journals written before `supersedes` existed keep both rows.
  const legacy = apply(streamed.state, piFinal(4));
  assert.equal(legacy.state.timeline.length, 2);
});

test('older pages and hydrated stubs cannot bring superseded progress back', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }), piProgress(2, 'Answer'), piFinal(3, ['m-1-assistant_progress-1'])];
  const seeded = runtime.createConversationRuntime('c', 'w', 2);
  const tail = apply(seeded, events[2]).state;
  const merged = runtime.prependConversationRuntimeEvents(tail, events.slice(0, 2));
  assert.deepEqual(merged.timeline.map((entry) => entry.category), ['assistant_final']);
  const hydrated = runtime.hydrateConversationRuntimeEvents(merged, events.slice(0, 2));
  assert.deepEqual(hydrated.timeline.map((entry) => entry.category), ['assistant_final']);
});

test('supersedes only removes progress rows of the named blocks in the same turn', () => {
  const narration = event(2, 'message.delta', { provider: 'pi', turnId: 't',
    delta: { type: 'text_delta', contentIndex: 0, delta: 'Checking files' },
    block: { category: 'assistant_progress', id: 'm-0-assistant_progress-0', turnId: 't', phase: 'delta' } });
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }), narration, piProgress(3, 'Answer'),
    piFinal(4, ['m-1-assistant_progress-1'])).state;
  assert.deepEqual(state.timeline.map((entry) => [entry.category, entry.subtitle]),
    [['assistant_final', 'Answer'], ['assistant_progress', 'Checking files']]);
});

// claude.rs: text streams as untyped text_delta, then one message.completed per content block.
function claudeCompleted(sequence, part) {
  return event(sequence, 'message.completed', { provider: 'claude-code', turnId: 't',
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [part] } });
}

test('Claude thinking and tool_use completions never become answer bubbles', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'thought.delta', { provider: 'claude-code', role: 'assistant', turnId: 't', delta: { type: 'thinking_delta', thinking: 'Plan the fix' } }),
    claudeCompleted(3, { type: 'thinking', thinking: 'Plan the fix', signature: 's' }),
    event(4, 'message.delta', { provider: 'claude-code', role: 'assistant', turnId: 't', delta: { type: 'text_delta', text: 'Hel' } }),
    event(5, 'message.delta', { provider: 'claude-code', role: 'assistant', turnId: 't', delta: { type: 'text_delta', text: 'lo' } }),
    claudeCompleted(6, { type: 'text', text: 'Hello' }),
    claudeCompleted(7, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } })).state;
  assert.deepEqual(state.timeline.filter((entry) => entry.kind === 'incoming').map((entry) => entry.subtitle), ['Hello']);
  assert.ok(state.timeline.some((entry) => entry.title === '思考中' && entry.subtitle === 'Plan the fix'));
  const mixed = parity.classifyV2ConversationEvent(event(8, 'message.completed', { turnId: 't', message: { role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Shown' }] } }), 'w', 't');
  assert.equal(mixed.subtitle, 'Shown');
});

// claude.rs tags every event emitted for a `parent_tool_use_id` frame with the
// spawning Task call's id: inner tools, streamed text, thinking and message
// envelopes all fold under the run instead of reaching the main stream.
function subTool(sequence, id, phase) {
  return event(sequence, `tool.${phase}`, { provider: 'claude-code', turnId: 't', toolCallId: id,
    subagentId: 'toolu_task', toolName: 'Read', result: 'data',
    block: { category: 'tool', id, turnId: 't', phase } });
}
function subDelta(sequence, text) {
  return event(sequence, 'message.delta', { provider: 'claude-code', role: 'assistant', turnId: 't',
    delta: { type: 'text_delta', text }, subagentId: 'toolu_task' });
}
function mainDelta(sequence, text) {
  return event(sequence, 'message.delta', { provider: 'claude-code', role: 'assistant', turnId: 't',
    delta: { type: 'text_delta', text } });
}
function mainCompleted(sequence, text) {
  return event(sequence, 'message.completed', { provider: 'claude-code', turnId: 't',
    message: { id: `msg_${sequence}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] } });
}

test('subagent activity between narration chunks never splits the assistant stream', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    mainDelta(2, 'All in '),
    subTool(3, 'toolu_inner1', 'started'), subDelta(4, 'exploring'), subTool(5, 'toolu_inner1', 'completed'),
    event(6, 'thought.delta', { provider: 'claude-code', turnId: 't', delta: { type: 'thinking_delta', thinking: 'inner plan' }, subagentId: 'toolu_task' }),
    mainDelta(7, 'one bubble.'),
    subTool(8, 'toolu_inner2', 'started'),
    event(9, 'turn.completed', { turnId: 't' })).state;
  const incoming = state.timeline.filter((entry) => entry.kind === 'incoming');
  assert.deepEqual(incoming.map((entry) => entry.subtitle), ['All in one bubble.']);
  // Subagent narration folds into the trace as its own step; tool rows keep
  // their entries but carry the run marker.
  const narration = state.timeline.find((entry) => entry.id === 'v2-subagent-c-toolu_task-text');
  assert.equal(narration.kind, 'system');
  assert.equal(narration.subtitle, 'exploring');
  assert.ok(parity.isStepProgressEntry(narration));
  const thinking = state.timeline.find((entry) => entry.id === 'v2-subagent-c-toolu_task-thought');
  assert.equal(thinking.subtitle, 'inner plan');
  const tools = state.timeline.filter((entry) => entry.subagentId === 'toolu_task' && entry.title === '工具调用');
  assert.equal(tools.length, 2);
});

test('a subagent message envelope cannot become a main-stream bubble', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    event(2, 'message.completed', { provider: 'claude-code', turnId: 't', subagentId: 'toolu_task',
      message: { role: 'assistant', content: [{ type: 'text', text: "I'll start by exploring" }] } }),
    mainDelta(3, 'Parent answer'),
    event(4, 'turn.completed', { turnId: 't' })).state;
  assert.deepEqual(state.timeline.filter((entry) => entry.kind === 'incoming').map((entry) => entry.subtitle), ['Parent answer']);
});

test('a completed assistant message supersedes the segments its deltas streamed', () => {
  const text = 'First part. Second part. Done.';
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    mainDelta(2, 'First part. '),
    event(3, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
    mainDelta(4, 'Second part. '),
    event(5, 'tool.completed', { turnId: 't', toolCallId: 'x', result: 'a.txt' }),
    mainDelta(6, 'Done.'),
    mainCompleted(7, text),
    event(8, 'turn.completed', { turnId: 't' })).state;
  const incoming = state.timeline.filter((entry) => entry.kind === 'incoming');
  assert.deepEqual(incoming.map((entry) => entry.subtitle), [text]);
  // Replay through reduceConversationEvents collapses the same stream.
  const replayed = parity.reduceConversationEvents([
    event(1, 'turn.started', { turnId: 't' }), mainDelta(2, 'First part. '),
    event(3, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
    mainDelta(4, 'Second part. '), event(5, 'tool.completed', { turnId: 't', toolCallId: 'x', result: 'a' }),
    mainDelta(6, 'Done.'), mainCompleted(7, text), event(8, 'turn.completed', { turnId: 't' })], 'w');
  assert.deepEqual(replayed.timeline.filter((entry) => entry.kind === 'incoming').map((entry) => entry.subtitle), [text]);
});

test('a completed message covers only the segments of its own message', () => {
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    mainDelta(2, 'Checking files'), mainCompleted(3, 'Checking files'),
    event(4, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'grep' }),
    mainDelta(5, 'All '), mainDelta(6, 'done'),
    mainCompleted(7, 'All done'),
    event(8, 'turn.completed', { turnId: 't' })).state;
  assert.deepEqual(state.timeline.filter((entry) => entry.kind === 'incoming').map((entry) => entry.subtitle),
    ['All done', 'Checking files']);
});

test('an interrupted segment whose text the completion lacks stays beside it', () => {
  // Journal gaps or provider quirks can leave a segment the final text does
  // not contain; coverage must keep it rather than silently drop real output.
  const state = apply(empty(), event(1, 'turn.started', { turnId: 't' }),
    mainDelta(2, 'Stray note. '),
    event(3, 'tool.started', { turnId: 't', toolCallId: 'x', toolName: 'ls' }),
    mainDelta(4, 'Done.'),
    mainCompleted(5, 'Done.'),
    event(6, 'turn.completed', { turnId: 't' })).state;
  assert.deepEqual(state.timeline.filter((entry) => entry.kind === 'incoming').map((entry) => entry.subtitle),
    ['Done.', 'Stray note. ']);
});

test('fragments paged in below a completed message collapse under it', () => {
  const events = [event(1, 'turn.started', { turnId: 't' }),
    mainDelta(2, 'One '), subTool(3, 'toolu_inner', 'completed'), mainDelta(4, 'two '),
    subDelta(5, 'inner work'), mainDelta(6, 'three'), mainCompleted(7, 'One two three'),
    event(8, 'turn.completed', { turnId: 't' })];
  const full = assertLazyMatchesFullReplay(events);
  assert.deepEqual(full.filter((row) => row.kind === 'incoming').map((row) => row.subtitle), ['One two three']);
});

test('a turn started below a lazy window is adopted without its history rows', () => {
  const started = event(2, 'turn.started', { turnId: 't', effectivePermissions: { sandbox: 'workspace-write' } });
  let state = runtime.createConversationRuntime('c', 'w', 40);
  state = runtime.adoptConversationRuntimeTurn(state, started);
  assert.equal(state.activeTurnId, 't');
  assert.equal(state.status, 'running');
  assert.equal(state.appliedSequence, 40);
  assert.deepEqual(state.timeline, []);
  assert.equal(state.effectiveConfig.sandbox, 'workspace-write');
  state = apply(state, event(41, 'message.delta', { text: 'Hi', turnId: 't' }), event(42, 'turn.completed', { turnId: 't' })).state;
  assert.equal(state.activeTurnId, '');
  assert.equal(state.status, 'completed');
  // A newer turn already tracked by the projection is never replaced.
  const tracked = apply(runtime.createConversationRuntime('c', 'w', 40), event(41, 'turn.started', { turnId: 'u' })).state;
  assert.equal(runtime.adoptConversationRuntimeTurn(tracked, started), tracked);
  assert.equal(runtime.adoptConversationRuntimeTurn(empty(), event(2, 'turn.completed', { turnId: 't' })).activeTurnId, '');
});

test('agent ssh_exec calls collect per execId without touching the timeline', () => {
  const events = [
    event(1, 'ssh.exec.started', { execId: 'a', host: 'web', command: 'uname -a', cwd: '/srv' }),
    event(2, 'ssh.exec.started', { execId: 'b', host: 'db', command: 'ls' }),
    event(3, 'ssh.exec.output', { execId: 'a', stream: 'stdout', data: 'Lin' }),
    event(4, 'ssh.exec.output', { execId: 'b', stream: 'stderr', data: 'denied\n' }),
    event(5, 'ssh.exec.output', { execId: 'a', stream: 'stdout', data: 'ux\n' }),
    event(6, 'ssh.exec.output', { execId: 'a', stream: 'stderr', data: 'warn\n' }),
    event(7, 'ssh.exec.completed', { execId: 'a', host: 'web', exitCode: 0, durationMs: 12, truncated: false, outputTruncated: false }),
    event(8, 'ssh.exec.completed', { execId: 'b', host: 'db', exitCode: 255, durationMs: 3, failure: 'authenticationFailed', truncated: false, outputTruncated: true }),
  ];
  const state = apply(empty(), ...events).state;
  assert.equal(state.timeline.length, 0);
  assert.deepEqual(state.sshExecs.map(run => [run.id, run.host, run.status]), [['a', 'web', 'completed'], ['b', 'db', 'failed']]);
  const [a, b] = state.sshExecs;
  assert.equal(a.command, 'uname -a');
  assert.equal(a.cwd, '/srv');
  assert.deepEqual(a.output, [{ stream: 'stdout', data: 'Linux\n' }, { stream: 'stderr', data: 'warn\n' }]);
  assert.equal(a.exitCode, 0);
  assert.equal(b.failure, 'authenticationFailed');
  assert.equal(b.outputTruncated, true);

  // Paging the start in below a window that only saw later frames.
  let paged = apply(runtime.createConversationRuntime('c', 'w', 4), ...events.slice(4)).state;
  assert.equal(paged.sshExecs.find(run => run.id === 'a').command, '');
  paged = runtime.prependConversationRuntimeEvents(paged, events.slice(0, 4));
  const merged = paged.sshExecs.find(run => run.id === 'a');
  assert.equal(merged.command, 'uname -a');
  assert.deepEqual(merged.output, a.output);
  assert.deepEqual(paged.sshExecs.map(run => run.id), ['a', 'b']);
});

test('ssh_exec runs are capped and cancellation is its own status', () => {
  const events = [];
  for (let index = 1; index <= 60; index += 1) {
    events.push(event(index, 'ssh.exec.started', { execId: `x${index}`, host: 'h', command: 'true' }));
  }
  events.push(event(61, 'ssh.exec.completed', { execId: 'x60', host: 'h', durationMs: 1, failure: 'cancelled' }));
  const state = apply(empty(), ...events).state;
  assert.equal(state.sshExecs.length, 50);
  assert.equal(state.sshExecs[0].id, 'x11');
  assert.equal(state.sshExecs.at(-1).status, 'cancelled');
});

test('desktop browser grants and actions collect without touching the timeline', () => {
  const action = (sequence, actionId, extra = {}) => event(sequence, 'desktop.browser.action', {
    actionId, tool: 'browser_snapshot', ok: true, summary: 'snapshot', deviceId: 'dev_desk', deviceName: 'Desk', ...extra,
  });
  const state = apply(empty(),
    event(1, 'desktop.browser.grant', { status: 'granted', deviceId: 'dev_desk', deviceName: 'Desk' }),
    action(2, 'a', { url: 'http://localhost:5173/', shotId: 'shot_1' }),
    action(3, 'a'),
    action(4, 'b', { ok: false, error: { code: 'NO_TAB', message: 'x' } }),
  ).state;
  assert.equal(state.timeline.length, 0);
  assert.equal(state.desktopBrowser.granted, true);
  assert.equal(state.desktopBrowser.deviceName, 'Desk');
  assert.deepEqual(state.desktopBrowser.actions.map(item => [item.actionId, item.ok, item.shotId]), [['a', true, 'shot_1'], ['b', false, undefined]]);
  const revoked = apply(state, event(5, 'desktop.browser.grant', { status: 'revoked', reason: 'user' })).state;
  assert.equal(revoked.desktopBrowser.granted, false);
  assert.equal(revoked.desktopBrowser.actions.length, 2);
  const many = apply(empty(), ...Array.from({ length: runtime.DESKTOP_BROWSER_ACTION_LIMIT + 5 }, (_, i) => action(i + 1, `x${i}`))).state;
  assert.equal(many.desktopBrowser.actions.length, runtime.DESKTOP_BROWSER_ACTION_LIMIT);
  assert.equal(many.desktopBrowser.actions[0].actionId, 'x5');
});

test('computer use sessions and actions collect without touching the timeline', () => {
  const action = (sequence, actionId, extra = {}) => event(sequence, 'desktop.computer.action', {
    actionId, tool: 'computer_act', ok: true, summary: 'click e3', deviceId: 'dev_mac', deviceName: 'Mac', ...extra,
  });
  const started = apply(empty(),
    event(1, 'desktop.computer.session', { status: 'started', deviceId: 'dev_mac', deviceName: 'Mac' }),
    action(2, 'a', { app: 'TextEdit', path: 'background', shotId: 'shot_1' }),
    action(2, 'a'),
  ).state;
  assert.equal(started.timeline.length, 0);
  assert.equal(started.desktopComputer.active, true);
  assert.equal(started.desktopComputer.deviceName, 'Mac');
  assert.deepEqual(started.desktopComputer.actions.map(item => [item.actionId, item.path, item.shotId]), [['a', 'background', 'shot_1']]);
  const ended = apply(started, event(3, 'desktop.computer.session', { status: 'ended', reason: 'done' })).state;
  assert.equal(ended.desktopComputer.active, false);
  assert.equal(ended.desktopComputer.actions.length, 1);
});
