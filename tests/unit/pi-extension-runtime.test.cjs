const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const runtime = require(path.join(__dirname, '../../dist/unit/lib/conversationRuntime.js'));
const parity = require(path.join(__dirname, '../../dist/unit/lib/mobileParity.js'));
const v2 = require(path.join(__dirname, '../../dist/unit/lib/v2.js'));
function event(sequence, type, payload = {}, extra = {}) {
  return { schemaVersion: 2, eventId: `event-${sequence}`, conversationId: 'c', sequence,
    time: '2026-09-11T00:00:00.000Z', type, payload, ...extra };
}
function empty() { return runtime.createConversationRuntime('c', 'w'); }
function apply(state, ...events) { return runtime.applyConversationRuntimeEvents(state, events); }
function lifecycle(sequence, runtimeId, status = 'ready') {
  return event(sequence, 'provider.runtime', { provider: 'pi', runtimeId, status });
}
function ui(sequence, method, fields = {}, runtimeId = 'r1') {
  return event(sequence, 'extension.ui', { provider: 'pi', runtimeId, scope: 'session', method, ...fields });
}
function custom(sequence, fields = {}, runtimeId = 'r1') {
  return event(sequence, 'extension.message', { provider: 'pi', runtimeId, scope: 'session', messageId: 'm1',
    message: { role: 'custom', customType: 'review-notes', content: 'Review is ready', display: true, ...fields } });
}
function permission(sequence, type, id, fields = {}) {
  return event(sequence, type, { provider: 'pi', permissionId: id, runtimeId: 'r1', scope: 'session', ...fields });
}

test('Pi status/widget/title/editor projection is deterministic through replay and gaps', () => {
  const events = [lifecycle(1, 'r1'), ui(2, 'setStatus', { statusKey: 'search', statusText: 'Searching' }),
    ui(3, 'setWidget', { widgetKey: 'results', widgetLines: ['one', 'two'], widgetPlacement: 'belowEditor' }),
    ui(4, 'setTitle', { title: 'Research' }), ui(5, 'set_editor_text', { text: 'Suggested follow-up' }),
    ui(6, 'setStatus', { statusKey: 'search', statusText: 'Done' })];
  let live = apply(empty(), events[2], events[4], events[5]);
  assert.equal(live.state.extensionUi.runtimeId, '');
  live = apply(live.state, events[0], events[1], events[3]);
  const replay = apply(empty(), ...events);
  assert.deepEqual(live.state, replay.state);
  assert.equal(replay.state.extensionUi.statuses.search.text, 'Done');
  assert.deepEqual(replay.state.extensionUi.widgets.results.lines, ['one', 'two']);
  assert.equal(replay.state.extensionUi.widgets.results.placement, 'belowEditor');
  assert.equal(replay.state.extensionUi.title, 'Research');
  assert.deepEqual(replay.state.extensionUi.editorRequest, { runtimeId: 'r1', eventId: 'event-5', sequence: 5, text: 'Suggested follow-up' });
  assert.equal(replay.state.status, 'idle');
  assert.equal(apply(replay.state, ...events).appliedEvents.length, 0);
});

test('omitted status/widget values clear their keyed components and retain siblings', () => {
  let update = apply(empty(), lifecycle(1, 'r1'), ui(2, 'setStatus', { statusKey: 'a', statusText: 'A' }),
    ui(3, 'setStatus', { statusKey: 'b', statusText: 'B' }), ui(4, 'setWidget', { widgetKey: 'a', widgetLines: ['A'] }),
    ui(5, 'setWidget', { widgetKey: 'b', widgetLines: ['B'] }));
  const previous = update.state;
  update = apply(previous, ui(6, 'setStatus', { statusKey: 'a' }), ui(7, 'setWidget', { widgetKey: 'a' }));
  assert.deepEqual(Object.keys(update.state.extensionUi.statuses), ['b']);
  assert.deepEqual(Object.keys(update.state.extensionUi.widgets), ['b']);
  assert.equal(previous.extensionUi.statuses.a.text, 'A');
  assert.deepEqual(previous.extensionUi.widgets.a.lines, ['A']);
});

test('replacement retires the old runtime and stops stale dialogs and UI frames from returning', () => {
  let update = apply(empty(), lifecycle(1, 'r1'), ui(2, 'setStatus', { statusKey: 'x', statusText: 'old' }),
    ui(3, 'setTitle', { title: 'old title' }), ui(4, 'set_editor_text', { text: 'old text' }),
    permission(5, 'permission.requested', 'p1', { details: { method: 'input' } }), lifecycle(6, 'r2'));
  assert.equal(update.state.extensionUi.runtimeId, 'r2');
  assert.deepEqual(update.state.extensionUi.statuses, {});
  assert.equal(update.state.extensionUi.title, undefined);
  assert.equal(update.state.extensionUi.editorRequest, undefined);
  assert.equal(update.state.pendingPermissions.length, 0);
  update = apply(update.state, ui(7, 'setStatus', { statusKey: 'x', statusText: 'late old' }),
    permission(8, 'permission.requested', 'p2'), lifecycle(9, 'r1'), lifecycle(10, 'r1', 'stopped'),
    ui(11, 'setStatus', { statusKey: 'x', statusText: 'current' }, 'r2'));
  assert.equal(update.state.providerRuntime.runtimeId, 'r2');
  assert.equal(update.state.providerRuntime.status, 'ready');
  assert.equal(update.state.extensionUi.statuses.x.text, 'current');
  assert.equal(update.state.pendingPermissions.length, 0);
});

test('stop clears temporary UI but preserves reviewable notices and custom messages', () => {
  const update = apply(empty(), lifecycle(1, 'r1'), ui(2, 'notify', { message: 'Review opened', notifyType: 'warning' }),
    custom(3), ui(4, 'setWidget', { widgetKey: 'pending', widgetLines: ['Waiting'] }),
    permission(5, 'permission.requested', 'p'), lifecycle(6, 'r1', 'stopped'),
    ui(7, 'notify', { message: 'late' }), custom(8, { content: 'late' }), lifecycle(9, 'r1'));
  assert.equal(update.state.providerRuntime.status, 'stopped');
  assert.deepEqual(update.state.extensionUi.widgets, {});
  assert.equal(update.state.pendingPermissions.length, 0);
  assert.deepEqual(update.state.extensionUi.notices.map(notice => notice.message), ['Review opened']);
  assert.equal(update.state.extensionUi.notices[0].eventId, 'event-2');
  assert.equal(update.state.extensionUi.notices[0].sequence, 2);
  const messages = update.state.timeline.filter(entry => entry.category === 'extension');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subtitle, 'Review is ready');
});

test('session forms do not inherit or end with the active turn, and resolution never starts a turn', () => {
  let update = apply(empty(), lifecycle(1, 'r1'), event(2, 'turn.started', { turnId: 't' }),
    permission(3, 'permission.requested', 'p', { turnId: 't', details: { method: 'confirm' } }));
  assert.equal(update.state.status, 'running');
  assert.equal(update.state.pendingPermissions[0].turnId, '');
  assert.equal(update.state.pendingPermissions[0].scope, 'session');
  update = apply(update.state, event(4, 'turn.completed', { turnId: 't' }));
  assert.equal(update.state.pendingPermissions.length, 1);
  assert.equal(update.state.status, 'completed');
  update = apply(update.state, permission(5, 'permission.resolved', 'p'));
  assert.equal(update.state.pendingPermissions.length, 0);
  assert.equal(update.state.activeTurnId, '');
  assert.equal(update.state.status, 'completed');
});

test('nested session scope is supported without losing ordinary turn approval lifecycle', () => {
  let update = apply(empty(), lifecycle(1, 'r1'), event(2, 'turn.started', { turnId: 't' }),
    event(3, 'permission.requested', { permissionId: 'session', details: { scope: 'session', runtimeId: 'r1', method: 'select' } }),
    permission(4, 'permission.requested', 'turn', { scope: 'turn', turnId: 't' }));
  assert.equal(update.state.status, 'waitingPermission');
  update = apply(update.state, permission(5, 'permission.resolved', 'turn', { scope: 'turn', turnId: 't' }));
  assert.equal(update.state.status, 'running');
  assert.deepEqual(update.state.pendingPermissions.map(item => item.id), ['session']);
  update = apply(update.state, event(6, 'turn.completed'));
  assert.equal(update.state.pendingPermissions.length, 1);
  assert.equal(update.state.status, 'completed');
});

test('new runtime may reuse a permission id without a late old resolution dismissing it', () => {
  const update = apply(empty(), lifecycle(1, 'r1'), permission(2, 'permission.requested', 'p'), lifecycle(3, 'r2'),
    permission(4, 'permission.requested', 'p', { runtimeId: 'r2' }), permission(5, 'permission.resolved', 'p'));
  assert.equal(update.state.pendingPermissions.length, 1);
  assert.equal(update.state.pendingPermissions[0].runtimeId, 'r2');
});

test('custom messages retain typed data, hide display=false, and stay separate from assistant finals', () => {
  const details = { filePath: 'PLAN.md', approved: false };
  const update = apply(empty(), lifecycle(1, 'r1'), event(2, 'turn.started', { turnId: 't' }),
    custom(3, { content: [{ type: 'text', text: 'First' }, { type: 'image', data: 'ignored-by-text-renderer' }, { type: 'text', text: 'Second' }], details, timestamp: 42 }),
    event(4, 'extension.message', { provider: 'pi', runtimeId: 'r1', scope: 'session', messageId: 'hidden',
      message: { role: 'custom', customType: 'internal', content: 'Do not render', display: false } }));
  assert.equal(update.state.timeline.length, 1);
  const entry = update.state.timeline[0];
  assert.equal(entry.category, 'extension');
  assert.equal(entry.kind, 'system');
  assert.equal(entry.turnId, '');
  assert.equal(entry.subtitle, 'First\nSecond');
  assert.equal(entry.extensionMessage.customType, 'review-notes');
  assert.deepEqual(entry.extensionMessage.details, details);
  assert.equal(entry.extensionMessage.timestamp, 42);
  assert.equal(parity.isVisibleConversationEntry(entry), true);
  assert.equal(parity.classifyV2ConversationEvent(custom(5, { display: false }), 'w'), null);
  assert.match(parity.classifyV2ConversationEvent(custom(6, { content: [{ type: 'image', data: 'x' }] }), 'w').subtitle, /非文本/);
});

test('custom messages with the same id in separate runtimes remain distinct history', () => {
  const update = apply(empty(), lifecycle(1, 'r1'), custom(2), lifecycle(3, 'r2'), custom(4, { content: 'New review' }, 'r2'));
  assert.equal(update.state.timeline.length, 2);
  assert.notEqual(update.state.timeline[0].id, update.state.timeline[1].id);
});

test('legacy opaque Pi UI events degrade to UI state without overriding a modern runtime', () => {
  const raw = (sequence, message) => event(sequence, 'provider.event', { provider: 'pi', providerMethod: 'extension_ui_request',
    metadata: { type: 'extension_ui_request', method: 'notify', message, notifyType: 'info' } });
  const update = apply(empty(), raw(1, 'Legacy notice'), lifecycle(2, 'r1'), raw(3, 'Unattributed late notice'));
  assert.equal(update.state.extensionUi.runtimeId, 'r1');
  assert.deepEqual(update.state.extensionUi.notices.map(item => item.message), ['Legacy notice']);
  assert.equal(update.state.timeline.length, 0);
});

test('conversation command catalogs include optional session identity without changing discovery requests', async () => {
  const urls = [];
  const response = { provider: 'pi', commands: [{ name: 'review', packageName: 'pi-review', packageVersion: '1.2.3' }],
    source: 'pi-rpc', fetchedAt: '2026-09-11T00:00:00.000Z', conversationId: 'c 1', runtimeId: 'r1', catalogSource: 'session' };
  const client = new v2.V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', fetchImpl: async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify(response), { status: 200 });
  } });
  const catalog = await client.listProviderCommands('pi', '/project', 'c 1');
  await client.listProviderCommands('pi', '/project');
  assert.equal(urls[0].searchParams.get('conversationId'), 'c 1');
  assert.equal(urls[1].searchParams.has('conversationId'), false);
  assert.deepEqual(catalog, response);
  assert.equal(v2.CONVERSATION_RUNTIME_STOP, 'conversation.runtime.stop');
});

test('new extension event names win over legacy normalized aliases', () => {
  assert.equal(v2.canonicalConversationEventType({ type: 'extension.message', normalizedType: 'assistant.delta' }), 'extension.message');
  assert.equal(v2.canonicalConversationEventType({ type: 'provider.runtime', normalizedType: 'provider.event' }), 'provider.runtime');
});


test('plugin component keys resembling object properties remain ordinary keyed entries', () => {
  const update = apply(empty(), lifecycle(1, 'r1'), ui(2, 'setStatus', { statusKey: '__proto__', statusText: 'status' }),
    ui(3, 'setWidget', { widgetKey: '__proto__', widgetLines: ['widget'] }));
  assert.equal(Object.hasOwn(update.state.extensionUi.statuses, '__proto__'), true);
  assert.equal(Object.hasOwn(update.state.extensionUi.widgets, '__proto__'), true);
  assert.equal(update.state.extensionUi.statuses.__proto__.text, 'status');
  assert.deepEqual(update.state.extensionUi.widgets.__proto__.lines, ['widget']);
  assert.equal(Object.getPrototypeOf(update.state.extensionUi.statuses), Object.prototype);
  assert.equal(Object.getPrototypeOf(update.state.extensionUi.widgets), Object.prototype);
});


test('legacy capabilities never imply Pi session controls or extension UI support', () => {
  const legacy = { nativeResume: true, cancel: true, permissions: true, toolEvents: true,
    nativeSkills: true, nativeMcp: false, managedMcp: false, modelSelection: true };
  const old = v2.providerCapabilityMatrix(legacy);
  assert.equal(old.runtimeStop, false);
  assert.equal(old.sessionCommands, false);
  assert.equal(old.extensionMessages, false);
  assert.deepEqual(old.extensionUi, []);
  const current = v2.providerCapabilityMatrix({ ...legacy, runtimeStop: true, sessionCommands: true,
    extensionMessages: true, extensionUi: ['select', 'confirm', 'input', 'editor', 'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'] });
  assert.equal(current.runtimeStop, true);
  assert.equal(current.sessionCommands, true);
  assert.equal(current.extensionMessages, true);
  assert.ok(current.extensionUi.includes('set_editor_text'));
});
