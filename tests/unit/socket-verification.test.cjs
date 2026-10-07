const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { startSocketVerification, SocketVerificationError } = require(path.join(compiledDir, 'socketVerification.js'));

/** Starts a verification whose server answers the ping through `respond`. */
function verify(respond, options) {
  let verification;
  const send = (text) => respond(JSON.parse(text), (frame) => queueMicrotask(() => verification.handleMessage(JSON.stringify(frame))));
  verification = startSocketVerification(send, options);
  return verification;
}

test('a matching pong verifies; unrelated messages are ignored', async () => {
  const verification = verify((ping, reply) => {
    reply({ id: 'other', type: 'server.result', payload: {} });
    reply({ id: ping.id, type: 'server.result', payload: { pong: true } });
  });
  await verification.done;
  assert.equal(verification.settled, true);
});

test('a wrong reply is a non-retryable failure; a drop, send failure or timeout is retryable', async () => {
  await assert.rejects(
    verify((ping, reply) => reply({ id: ping.id, type: 'server.error', payload: {} })).done,
    (error) => error instanceof SocketVerificationError && !error.retryable,
  );
  const dropping = verify(() => {});
  dropping.fail();
  await assert.rejects(dropping.done, (error) => error instanceof SocketVerificationError && error.retryable);
  await assert.rejects(verify(() => {}, { timeoutMs: 5 }).done, (error) => error.retryable === true);
  const throwing = startSocketVerification(() => { throw new Error('socket closed'); });
  await assert.rejects(throwing.done, (error) => error instanceof SocketVerificationError && error.retryable);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verify(() => {}, { signal: controller.signal }).done, { name: 'AbortError' });
});
