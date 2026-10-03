const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { V2ApiClient } = require(path.join(compiledDir, 'v2.js'));
const { ConnectionError } = require(path.join(compiledDir, 'connectionError.js'));
const ssh = require(path.join(compiledDir, 'ssh.js'));

function recordingClient(responses = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { api: new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', fetchImpl }), calls };
}

test('SSH host routes use the contract paths, methods and bodies', async () => {
  const { api, calls } = recordingClient();
  const host = { alias: 'prod web', hostName: 'example.com', port: 2222, user: 'deploy' };
  await api.listSshHosts();
  await api.createSshHost(host);
  await api.importSshHosts('Host a\n  HostName a.example');
  await api.updateSshHost('prod web', host);
  await api.deleteSshHost('prod web');
  await api.setSshHostAgentAccess('prod web', true);
  await api.testSshHost('prod web');
  await api.disconnectSshHost('prod web');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'GET /v2/ssh/hosts',
    'POST /v2/ssh/hosts',
    'POST /v2/ssh/hosts/import',
    'PUT /v2/ssh/hosts/prod%20web',
    'DELETE /v2/ssh/hosts/prod%20web',
    'PUT /v2/ssh/hosts/prod%20web/agent-access',
    'POST /v2/ssh/hosts/prod%20web/test',
    'POST /v2/ssh/hosts/prod%20web/disconnect',
  ]);
  assert.deepEqual(calls[1].body, host);
  assert.deepEqual(calls[2].body, { text: 'Host a\n  HostName a.example' });
  assert.deepEqual(calls[5].body, { enabled: true });
});

test('FTP site and key routes match the contract', async () => {
  const { api, calls } = recordingClient();
  const site = { name: 'Files', protocol: 'ftps', host: 'ftp.example.com', port: 990, user: 'me' };
  await api.createFtpSite(site);
  await api.updateFtpSite('site/1', site);
  await api.deleteFtpSite('site/1');
  await api.listSshKeys();
  await api.importSshKey({ name: 'work', privateKey: 'PRIVATE', passphrase: 'pw' });
  await api.generateSshKey({ name: 'id_new', algorithm: 'ed25519', comment: 'me@host' });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'POST /v2/ftp/sites',
    'PUT /v2/ftp/sites/site%2F1',
    'DELETE /v2/ftp/sites/site%2F1',
    'GET /v2/ssh/keys',
    'POST /v2/ssh/keys/import',
    'POST /v2/ssh/keys/generate',
  ]);
  assert.deepEqual(calls[0].body, site);
  assert.deepEqual(calls[4].body, { name: 'work', privateKey: 'PRIVATE', passphrase: 'pw' });
  assert.deepEqual(calls[5].body, { name: 'id_new', algorithm: 'ed25519', comment: 'me@host' });
});

test('remote connection file operations encode ids and query paths', async () => {
  const { api, calls } = recordingClient();
  await api.listRemoteConnections();
  await api.openRemoteConnection({ kind: 'sftp', host: 'prod', password: 'once' });
  await api.listRemoteEntries('c 1', '/srv/my app');
  await api.readRemoteFile('c 1', '/srv/a&b.txt');
  await api.saveRemoteFile('c 1', '/srv/a.txt', 'new', 'old');
  await api.createRemoteDirectory('c 1', '/srv/new');
  await api.renameRemoteEntry('c 1', '/srv/a', '/srv/b');
  await api.deleteRemoteEntry('c 1', '/srv/b');
  await api.uploadRemoteFile('c 1', '/srv/up.bin', 'AAEC', true);
  await api.downloadRemoteFile('c 1', '/srv/up.bin');
  await api.closeRemoteConnection('c 1');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'GET /v2/remote/connections',
    'POST /v2/remote/connections',
    'GET /v2/remote/connections/c%201/entries',
    'GET /v2/remote/connections/c%201/file',
    'PUT /v2/remote/connections/c%201/file',
    'POST /v2/remote/connections/c%201/mkdir',
    'POST /v2/remote/connections/c%201/rename',
    'POST /v2/remote/connections/c%201/delete',
    'PUT /v2/remote/connections/c%201/upload',
    'GET /v2/remote/connections/c%201/download',
    'DELETE /v2/remote/connections/c%201',
  ]);
  assert.deepEqual(calls[1].body, { kind: 'sftp', host: 'prod', password: 'once' });
  assert.equal(calls[2].url.searchParams.get('path'), '/srv/my app');
  assert.equal(calls[3].url.searchParams.get('path'), '/srv/a&b.txt');
  assert.deepEqual(calls[4].body, { path: '/srv/a.txt', text: 'new', expectedText: 'old' });
  assert.deepEqual(calls[6].body, { from: '/srv/a', to: '/srv/b' });
  assert.deepEqual(calls[8].body, { path: '/srv/up.bin', data: 'AAEC', overwrite: true });
  assert.equal(calls[9].url.searchParams.get('path'), '/srv/up.bin');
});

test('remote errors expose the backend code for auth and host-key handling', async () => {
  const { api } = recordingClient([
    { status: 401, body: { code: 'REMOTE_AUTH_FAILED', message: 'password required' } },
    { status: 409, body: { code: 'REMOTE_HOST_KEY_UNVERIFIED', message: 'unknown host key' } },
    { status: 404, body: { code: 'NOT_FOUND', message: 'no route' } },
  ]);
  const authError = await api.openRemoteConnection({ kind: 'sftp', host: 'prod' }).catch((error) => error);
  assert.ok(authError instanceof ConnectionError);
  assert.equal(ssh.isRemoteAuthFailure(authError), true);
  const hostKeyError = await api.openRemoteConnection({ kind: 'sftp', host: 'prod' }).catch((error) => error);
  assert.equal(ssh.isRemoteHostKeyUnverified(hostKeyError), true);
  assert.equal(ssh.isRemoteAuthFailure(hostKeyError), false);
  const missing = await api.listSshHosts().catch((error) => error);
  assert.equal(ssh.isNotFoundError(missing), true);
});

test('SSH helpers format endpoints, validate key names and join POSIX paths', () => {
  assert.equal(ssh.sshHostEndpoint({ alias: 'prod', resolved: { hostName: 'h.example', user: 'me', port: 22, identityFiles: [] } }), 'me@h.example:22');
  assert.equal(ssh.sshHostEndpoint({ alias: 'prod' }), 'prod');
  assert.equal(ssh.isValidSshKeyName('id_ed25519'), true);
  assert.equal(ssh.isValidSshKeyName('.hidden'), false);
  assert.equal(ssh.isValidSshKeyName('-dash'), false);
  assert.equal(ssh.isValidSshKeyName('a/b'), false);
  assert.equal(ssh.isValidSshKeyName('x'.repeat(65)), false);
  assert.equal(ssh.isSshFailureKind('hostKeyChanged'), true);
  assert.equal(ssh.isSshFailureKind('nope'), false);
  assert.equal(ssh.remoteJoinPath('/srv/', 'a.txt'), '/srv/a.txt');
  assert.equal(ssh.remoteJoinPath('/', 'a.txt'), '/a.txt');
  assert.equal(ssh.remoteParentPath('/srv/a.txt'), '/srv');
  assert.equal(ssh.remoteParentPath('/a.txt'), '/');
  assert.equal(ssh.remoteBaseName('/srv/dir/'), 'dir');
});
