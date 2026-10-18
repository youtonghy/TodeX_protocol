const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const runtime = require(path.join(__dirname, '../../dist/unit/lib/conversationRuntime.js'));
const v2 = require(path.join(__dirname, '../../dist/unit/lib/v2.js'));
const calling = require(path.join(__dirname, '../../dist/unit/lib/agentCalling.js'));

function event(sequence, type, payload = {}) {
  return { schemaVersion: 2, eventId: `event-${sequence}`, conversationId: 'p', sequence,
    time: `2026-10-18T00:00:${String(sequence).padStart(2, '0')}.000Z`, type, payload: { turnId: 'parent-turn', ...payload } };
}
function empty(floor = 0) { return runtime.createConversationRuntime('p', 'w', floor); }
function apply(state, ...events) { return runtime.applyConversationRuntimeEvents(state, events).state; }
const started = (sequence, child, turn, extra = {}) => event(sequence, 'agent.call.started', {
  childConversationId: child, childTurnId: turn, agent: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high',
  text: `task ${turn}`, status: 'running', startedAt: '2026-10-18T00:00:00.000Z', ...extra });
const completed = (sequence, child, turn, output = `done ${turn}`) => event(sequence, 'agent.call.completed', {
  childConversationId: child, childTurnId: turn, status: 'completed', output, durationMs: 1200 });

test('constants name the todex_agents server and its tools', () => {
  assert.equal(calling.AGENT_CALLING_SERVER, 'todex_agents');
  assert.deepEqual([...calling.AGENT_CALLING_TOOLS], ['agents_list', 'agent_run', 'agent_turn', 'agent_wait', 'agent_cancel']);
  assert.equal(calling.isAgentCallingTool('agent_run'), true);
  assert.equal(calling.isAgentCallingTool('browser_open'), false);
});

test('agent.call events keep their type and add no timeline rows', () => {
  assert.equal(v2.canonicalConversationEventType({ type: 'agent.call.started', normalizedType: 'tool.started' }), 'agent.call.started');
  const state = apply(empty(), started(1, 'c1', 't1'), completed(2, 'c1', 't1'));
  assert.equal(state.timeline.length, 0);
});

test('one session per child; turns in start order; status follows the latest turn', () => {
  const state = apply(empty(),
    started(1, 'c1', 't1', { title: 'Review' }),
    event(2, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't1', status: 'waiting_permission' }),
    completed(3, 'c1', 't1'),
    started(4, 'c1', 't2', { model: 'gpt-6-astra-mini', reasoningEffort: undefined }));
  assert.equal(state.agentCalls.length, 1);
  const session = state.agentCalls[0];
  assert.equal(session.childConversationId, 'c1');
  assert.equal(session.agent, 'codex');
  assert.equal(session.title, 'Review');
  assert.equal(session.status, 'running');
  assert.equal(session.updatedSequence, 4);
  assert.deepEqual(session.turns.map(turn => [turn.childTurnId, turn.status]), [['t1', 'completed'], ['t2', 'running']]);
  assert.deepEqual(session.turns[0], { childTurnId: 't1', text: 'task t1', status: 'completed', model: 'gpt-6-astra',
    reasoningEffort: 'high', startedAt: '2026-10-18T00:00:00.000Z', output: 'done t1', durationMs: 1200 });
  assert.equal(session.turns[1].model, 'gpt-6-astra-mini');
  assert.equal(session.turns[1].reasoningEffort, undefined);
});

test('waiting_permission shows on the session and returns to running', () => {
  let state = apply(empty(), started(1, 'c1', 't1'),
    event(2, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't1', status: 'waiting_permission' }));
  assert.equal(state.agentCalls[0].status, 'waiting_permission');
  state = apply(state, event(3, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't1', status: 'running' }));
  assert.equal(state.agentCalls[0].status, 'running');
});

test('failed and cancelled calls carry their error and output', () => {
  const state = apply(empty(),
    started(1, 'c1', 't1'), started(2, 'c2', 't2'), started(3, 'c3', 't3'),
    event(4, 'agent.call.failed', { childConversationId: 'c1', childTurnId: 't1', status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'boom' }, output: 'partial', durationMs: 50 }),
    event(5, 'agent.call.failed', { childConversationId: 'c2', childTurnId: 't2', status: 'interrupted',
      error: { code: 'DAEMON_RESTARTED', message: 'restarted' } }),
    event(6, 'agent.call.cancelled', { childConversationId: 'c3', childTurnId: 't3', status: 'cancelled', output: 'half' }));
  const byId = Object.fromEntries(state.agentCalls.map(item => [item.childConversationId, item]));
  assert.equal(byId.c1.status, 'failed');
  assert.deepEqual(byId.c1.turns[0].error, { code: 'PROVIDER_ERROR', message: 'boom' });
  assert.equal(byId.c1.turns[0].output, 'partial');
  assert.equal(byId.c2.status, 'interrupted');
  assert.equal(byId.c2.turns[0].error.code, 'DAEMON_RESTARTED');
  assert.equal(byId.c3.status, 'cancelled');
  assert.equal(byId.c3.turns[0].output, 'half');
});

test('active sessions sort before settled ones and keep their slot while updating', () => {
  let state = apply(empty(), started(1, 'a', 'ta'), started(2, 'b', 'tb'), started(3, 'c', 'tc'));
  assert.deepEqual(state.agentCalls.map(item => item.childConversationId), ['c', 'b', 'a']);
  state = apply(state, event(4, 'agent.call.updated', { childConversationId: 'a', childTurnId: 'ta', status: 'waiting_permission' }));
  assert.deepEqual(state.agentCalls.map(item => item.childConversationId), ['c', 'b', 'a']);
  state = apply(state, completed(5, 'c', 'tc'));
  assert.deepEqual(state.agentCalls.map(item => item.childConversationId), ['b', 'a', 'c']);
  state = apply(state, completed(6, 'b', 'tb'));
  assert.deepEqual(state.agentCalls.map(item => item.childConversationId), ['a', 'b', 'c']);
  // A follow-up turn reactivates a settled child.
  state = apply(state, started(7, 'c', 'tc2'));
  assert.deepEqual(state.agentCalls.map(item => item.childConversationId), ['c', 'a', 'b']);
});

test('late updated frames and duplicated starts never resurrect a settled call', () => {
  const state = apply(empty(), started(1, 'c1', 't1'), completed(2, 'c1', 't1'),
    event(3, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't1', status: 'running' }),
    started(4, 'c1', 't1', { text: 'replayed', model: 'other' }),
    event(5, 'agent.call.failed', { childConversationId: 'c1', childTurnId: 't1', status: 'failed', error: { message: 'late' } }));
  const session = state.agentCalls[0];
  assert.equal(session.turns.length, 1);
  assert.equal(session.status, 'completed');
  assert.equal(session.turns[0].text, 'task t1');
  assert.equal(session.turns[0].model, 'gpt-6-astra');
  assert.equal(session.turns[0].output, 'done t1');
  assert.equal(session.turns[0].error, undefined);
});

test('events without a child id, or progress for an unknown turn status, are ignored', () => {
  const state = apply(empty(),
    event(1, 'agent.call.started', { childTurnId: 't1', agent: 'codex', text: 'x' }),
    event(2, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't1', status: 'bogus' }));
  assert.deepEqual(state.agentCalls, []);
});

test('replaying the same events is idempotent', () => {
  const events = [started(1, 'c1', 't1'), completed(2, 'c1', 't1'), started(3, 'c2', 't2')];
  const once = apply(empty(), ...events);
  const twice = apply(once, ...events);
  assert.equal(twice, once);
  assert.deepEqual(apply(empty(), ...events).agentCalls, once.agentCalls);
});

test('history paged in below the window heals placeholder sessions like a full replay', () => {
  const events = [
    started(1, 'c0', 't0', { agent: 'claude-code', title: 'Old' }), completed(2, 'c0', 't0'),
    started(3, 'c1', 't1', { title: 'Main' }), completed(4, 'c1', 't1'),
    started(5, 'c1', 't2'),
    event(6, 'agent.call.updated', { childConversationId: 'c1', childTurnId: 't2', status: 'waiting_permission' }),
    completed(7, 'c1', 't2'),
  ];
  const full = apply(empty(), ...events);
  let lazy = apply(empty(5), ...events.filter(item => item.sequence > 5));
  // Only progress for t2 is loaded: an untitled placeholder with no task.
  assert.equal(lazy.agentCalls.length, 1);
  assert.equal(lazy.agentCalls[0].agent, '');
  assert.equal(lazy.agentCalls[0].turns[0].text, '');
  lazy = runtime.prependConversationRuntimeEvents(lazy, events.filter(item => item.sequence > 2 && item.sequence <= 5));
  lazy = runtime.prependConversationRuntimeEvents(lazy, events.filter(item => item.sequence <= 2));
  assert.deepEqual(lazy.agentCalls.map(item => item.childConversationId), full.agentCalls.map(item => item.childConversationId));
  const main = lazy.agentCalls.find(item => item.childConversationId === 'c1');
  const expected = full.agentCalls.find(item => item.childConversationId === 'c1');
  assert.equal(main.agent, 'codex');
  assert.equal(main.title, 'Main');
  assert.equal(main.status, 'completed');
  assert.deepEqual(main.turns.map(turn => turn.childTurnId), ['t1', 't2']);
  assert.deepEqual(main.turns, expected.turns);
  assert.equal(lazy.agentCalls.find(item => item.childConversationId === 'c0').agent, 'claude-code');
});

test('paging in an earlier running call keeps active sessions first', () => {
  const events = [started(1, 'old', 't-old'), started(2, 'new', 't-new'), completed(3, 'new', 't-new')];
  let lazy = apply(empty(2), events[2]);
  lazy = runtime.prependConversationRuntimeEvents(lazy, events.slice(0, 2));
  assert.deepEqual(lazy.agentCalls.map(item => [item.childConversationId, item.status]), [['old', 'running'], ['new', 'completed']]);
});

test('agent calling tool names are recognised in every provider spelling', () => {
  assert.equal(calling.agentCallingToolFromName('mcp__todex_agents__agent_run'), 'agent_run');
  assert.equal(calling.agentCallingToolFromName('todex_agents.agents_list'), 'agents_list');
  assert.equal(calling.agentCallingToolFromName('todex_agents/agent_cancel'), 'agent_cancel');
  assert.equal(calling.agentCallingToolFromName('mcp__todex_agents__unknown'), null);
  assert.equal(calling.agentCallingToolFromName('mcp__todex_desktop__browser_open'), null);
  assert.equal(calling.agentCallingToolSummary(JSON.stringify({ agent: 'codex', text: '\nReview the diff\nthen fix' })), 'codex · Review the diff');
  assert.equal(calling.agentCallingToolSummary(JSON.stringify({ conversationId: 'c1', waitSecs: 30 })), 'c1');
  assert.equal(calling.agentCallingToolSummary('not json'), '');
});
