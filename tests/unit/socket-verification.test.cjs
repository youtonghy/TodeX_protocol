const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { verifyEncryptedSocket, SocketVerificationError } = require(path.join(compiledDir, 'socketVerification.js'));

/** A socket whose server answers the ping through `respond`. */
function fakeSocket(respond) {
  const listeners = { message: new Set(), close: new Set(), error: new Set() };
  const socket = {
    listeners,
    send(text) { respond(JSON.parse(text), (frame) => listeners.message.forEach(l => l({ data: JSON.stringify(frame) }))); },
    addEventListener(type, listener) { listeners[type].add(listener); },
    removeEventListener(type, listener) { listeners[type].delete(listener); },
  };
  return socket;
}
// Identity "crypto": enough to test the handshake logic.
const session = { encryptClientText: (text) => text, decryptServerText: (text) => text };

test('a matching pong verifies and removes every listener', async () => {
  const socket = fakeSocket((ping, reply) => {
    reply({ id: 'other', type: 'server.result', payload: {} });
    reply({ id: ping.id, type: 'server.result', payload: { pong: true } });
  });
  await verifyEncryptedSocket(socket, session);
  assert.equal(socket.listeners.message.size + socket.listeners.close.size + socket.listeners.error.size, 0);
});

test('a wrong reply is a non-retryable failure; a drop or timeout is retryable', async () => {
  await assert.rejects(
    verifyEncryptedSocket(fakeSocket((ping, reply) => reply({ id: ping.id, type: 'server.error', payload: {} })), session),
    (error) => error instanceof SocketVerificationError && !error.retryable,
  );
  const dropping = fakeSocket(() => {});
  const pending = verifyEncryptedSocket(dropping, session);
  dropping.listeners.close.forEach(l => l({}));
  await assert.rejects(pending, (error) => error instanceof SocketVerificationError && error.retryable);
  await assert.rejects(
    verifyEncryptedSocket(fakeSocket(() => {}), session, { timeoutMs: 5 }),
    (error) => error.retryable === true,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(verifyEncryptedSocket(fakeSocket(() => {}), session, { signal: controller.signal }), { name: 'AbortError' });
});
