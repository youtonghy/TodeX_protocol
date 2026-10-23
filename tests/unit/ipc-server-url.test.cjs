const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { ipcServerInstance, ipcServerUrl, isIpcServerUrl, setIpcWebSocketImpl } = require(path.join(lib, 'ipcServerUrl.js'));
const { isLocalBackendUrl, isLoopbackUrl, normalizeBackendConnectionProfile } = require(path.join(lib, 'mobileParity.js'));
const { buildHttpUrl, normalizeServerUrl } = require(path.join(lib, 'todex.js'));
const { inspectServerUrl } = require(path.join(lib, 'connectionProbe.js'));
const { createSecureTransport } = require(path.join(lib, 'secureTransport.js'));

test('IPC server URLs parse to a lowercase instance id', () => {
  assert.equal(ipcServerInstance('todex-ipc://local'), 'local');
  assert.equal(ipcServerInstance(' TODEX-IPC://Container-Dev/ '), 'container-dev');
  assert.equal(ipcServerInstance('todex-ipc://local/v2/ws?tv=2'), 'local');
  for (const value of ['todex-ipc://', 'todex-ipc://a b', 'todex-ipc://user@local', 'todex-ipc://local:1', 'todex-ipc://-x', 'http://local', null]) {
    assert.equal(ipcServerInstance(value), null, String(value));
  }
  assert.equal(ipcServerUrl('Local'), 'todex-ipc://local');
  assert.throws(() => ipcServerUrl('../x'), TypeError);
});

test('IPC backends are local backends but never loopback preview URLs', () => {
  assert.equal(isIpcServerUrl('todex-ipc://local'), true);
  assert.equal(isLocalBackendUrl('todex-ipc://local'), true);
  assert.equal(isLocalBackendUrl('http://127.0.0.1:7345'), true);
  assert.equal(isLocalBackendUrl('http://10.0.0.2:7345'), false);
  assert.equal(isLoopbackUrl('todex-ipc://local'), false);
});

test('server URL helpers keep IPC URLs intact', () => {
  assert.equal(normalizeServerUrl('todex-ipc://Local/'), 'todex-ipc://local');
  assert.equal(buildHttpUrl('todex-ipc://local', '/v2/version'), 'todex-ipc://local/v2/version');
  assert.deepEqual(inspectServerUrl('todex-ipc://local'), { origin: 'todex-ipc://local', error: null });
  assert.equal(normalizeBackendConnectionProfile({ id: 'a', serverUrl: 'todex-ipc://local' }).serverUrl, 'todex-ipc://local');
});

test('an unpaired IPC profile may use plaintext and opens sockets through the registered implementation', () => {
  const profile = { serverUrl: 'todex-ipc://local', encryptionProtocol: 'none', encryptionPublicKey: '' };
  const transport = createSecureTransport({ profile, fetchImpl: async () => new Response('{}') });
  assert.equal(transport.mode, 'plaintext');

  assert.throws(() => transport.openSocket({}), /cannot open local IPC backends/);
  const opened = [];
  class FakeSocket {
    constructor(url) { opened.push(url); }
    send() {}
    close() {}
  }
  setIpcWebSocketImpl(FakeSocket);
  try {
    transport.openSocket({ query: { a: 'b' } });
    assert.equal(opened[0], 'todex-ipc://local/v2/ws?a=b');
  } finally {
    setIpcWebSocketImpl(null);
  }
});

test('a registered IPC fetch serves IPC profiles only', async () => {
  const { setIpcFetchImpl } = require(path.join(lib, 'ipcServerUrl.js'));
  const seen = [];
  setIpcFetchImpl(async (url) => { seen.push(String(url)); return new Response('{"ok":true}'); });
  try {
    const transport = createSecureTransport({ profile: { serverUrl: 'todex-ipc://local', encryptionProtocol: 'none', encryptionPublicKey: '' } });
    await transport.fetch({ method: 'GET', path: '/v2/version' });
    assert.deepEqual(seen, ['todex-ipc://local/v2/version']);
  } finally {
    setIpcFetchImpl(null);
  }
});
