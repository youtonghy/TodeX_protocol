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
