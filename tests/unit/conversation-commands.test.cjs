const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ConversationCommands, CommandOutcomeUnknown, controlFrame, followUpQueueFrame, promptContentFromAttachments } = require('../../dist/unit/lib/conversationCommands.js');
const frame = { id: 'request-1', type: 'conversation.prompt', payload: { conversationId: 'c', text: 'hello' } };

test('command rejection is correlated, settles once, and does not resend', async () => {
  const commands = new ConversationCommands();
  let sent = 0;
  const pending = commands.send(frame, () => { sent++; return true; });
  assert.equal(commands.settle('other', {}, 'wrong request'), false);
  assert.equal(commands.settle(frame.id, undefined, 'provider rejected'), true);
  await assert.rejects(pending, error => error.message === 'provider rejected' && !(error instanceof CommandOutcomeUnknown));
  assert.equal(commands.settle(frame.id, {}), false);
  assert.equal(sent, 1);
});

test('disconnection marks accepted transport writes unknown without replaying them', async () => {
  const commands = new ConversationCommands();
  let sent = 0;
  const pending = commands.send(frame, () => { sent++; return true; });
  commands.disconnect();
  await assert.rejects(pending, CommandOutcomeUnknown);
  assert.equal(sent, 1);
  assert.equal(commands.settle(frame.id, {}), false);
});

test('timeout remains unknown and a definite disconnected send is rejected', async () => {
  const commands = new ConversationCommands();
  let sent = 0;
  await assert.rejects(commands.send(frame, () => { sent++; return true; }, 5), CommandOutcomeUnknown);
  assert.equal(sent, 1);
  await assert.rejects(commands.send(frame, () => false), error => !(error instanceof CommandOutcomeUnknown));
});

test('duplicate pending request IDs cannot overwrite the original acknowledgement', async () => {
  const commands = new ConversationCommands();
  let sent = 0;
  const first = commands.send(frame, () => { sent++; return true; });
  await assert.rejects(commands.send(frame, () => { sent++; return true; }), /ID/);
  commands.settle(frame.id, { turnId: 'turn-1' });
  assert.deepEqual(await first, { turnId: 'turn-1' });
  assert.equal(sent, 1);
});

test('attachments preserve supported image and empty text file content', () => {
  assert.deepEqual(promptContentFromAttachments([
    { kind: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVs\nbG8=' },
    { kind: 'file', name: 'empty.txt', mimeType: 'text/plain', dataUrl: '', textContent: '' },
  ]), [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'text', text: '[附件: empty.txt]\n' }]);
  for (const dataUrl of ['data:image/png;base64,=', 'data:image/png;base64,  ', 'data:image/png;base64,a=b=', 'data:text/plain;base64,aGVsbG8=', 'https://example.com/a.png']) {
    assert.throws(() => promptContentFromAttachments([{ kind: 'image', name: 'bad.png', mimeType: 'image/png', dataUrl }]), /bad.png/);
  }
  assert.throws(() => promptContentFromAttachments([{ kind: 'file', name: 'binary.zip', mimeType: 'application/zip', dataUrl: 'data:application/zip;base64,aGVsbG8=' }]), /binary.zip/);
});

test('live controls use the backend strict conversation.control envelope', () => {
  assert.deepEqual(controlFrame('steer', 'c', { expectedTurnId: 't', text: 'change direction', conversationId: 'wrong' }), {
    type: 'conversation.control', payload: { conversationId: 'c', expectedTurnId: 't', control: { action: 'steer', text: 'change direction' } },
  });
  assert.deepEqual(controlFrame('queue', 'c', { expectedTurnId: 't', itemId: 'item', text: 'next' }).payload.control, { action: 'queueAdd', itemId: 'item', text: 'next' });
  assert.deepEqual(controlFrame('queue', 'c', { expectedTurnId: 't', control: { action: 'queueRemove', itemId: 'item' } }).payload.control, { action: 'queueRemove', itemId: 'item' });
  assert.deepEqual(controlFrame('queue', 'c', { expectedTurnId: 't', control: { action: 'queueList' } }).payload.control, { action: 'queueList' });
  assert.throws(() => controlFrame('steer', 'c', { text: 'next' }), /轮次/);
  assert.throws(() => controlFrame('queue', 'c', { expectedTurnId: 't', text: 'next' }), /ID/);
  assert.throws(() => controlFrame('queue', 'c', { expectedTurnId: 't', control: { action: 'configure', itemId: 'x', text: 'x' } }), /不支持/);
  assert.deepEqual(controlFrame('followUp', 'c', { text: 'follow up' }), { type: 'conversation.followUp', payload: { text: 'follow up', conversationId: 'c' } });
  assert.deepEqual(controlFrame('cancel', 'c'), { type: 'conversation.cancel', payload: { conversationId: 'c' } });
});

test('follow-up queue frames name the backend queue command and require item ids', () => {
  assert.deepEqual(followUpQueueFrame('add', 'c', { itemId: ' q1 ', text: 'next', front: true, content: [{ type: 'text', text: 'x' }] }), {
    type: 'conversation.queue.add',
    payload: { itemId: 'q1', text: 'next', front: true, content: [{ type: 'text', text: 'x' }], conversationId: 'c' },
  });
  assert.deepEqual(followUpQueueFrame('remove', 'c', { itemId: 'q1', text: 'ignored' }), { type: 'conversation.queue.remove', payload: { itemId: 'q1', conversationId: 'c' } });
  assert.deepEqual(followUpQueueFrame('take', 'c', { itemId: ' q1 ' }), { type: 'conversation.queue.take', payload: { itemId: 'q1', conversationId: 'c' } });
  assert.deepEqual(followUpQueueFrame('add', 'c', { itemId: 'q1', text: 'x', paused: true }).payload.paused, true);
  assert.throws(() => followUpQueueFrame('take', 'c', {}), /消息 ID/);
  for (const operation of ['clear', 'resume', 'list', 'pause']) {
    assert.deepEqual(followUpQueueFrame(operation, 'c', { itemId: 'q1' }), { type: `conversation.queue.${operation}`, payload: { conversationId: 'c' } });
  }
  assert.throws(() => followUpQueueFrame('add', 'c', { text: 'next' }), /消息 ID/);
  assert.throws(() => followUpQueueFrame('remove', 'c', { itemId: ' ' }), /消息 ID/);
  assert.throws(() => followUpQueueFrame('list', ' '), /会话 ID/);
});

test('cancel names the turn it means and passes a stale-turn answer through', async () => {
  const { V2ApiClient } = require('../../dist/unit/lib/v2.js');
  const bodies = [];
  const answers = [{ conversationId: 'c 1', cancelled: false, activeTurnId: 'turn-2' }, { conversationId: 'c 1', accepted: true }];
  const client = new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/v2/conversations/c%201/cancel');
    bodies.push(JSON.parse(new TextDecoder().decode(init.body)));
    return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(await client.cancel('c 1', 'turn-1'), { conversationId: 'c 1', cancelled: false, activeTurnId: 'turn-2' });
  await client.cancel('c 1');
  assert.deepEqual(bodies, [{ turnId: 'turn-1' }, {}]);
});
