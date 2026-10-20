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
    calls.push({
      url: new URL(url),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      // The transport sends every body as bytes; JSON ones are decoded here.
      body: !init.body?.length ? undefined
        : new Headers(init.headers).get('content-type') === 'application/json'
          ? JSON.parse(new TextDecoder().decode(init.body)) : init.body,
    });
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

test('SSH connection settings round-trip through /v2/ssh/settings', async () => {
  const settings = { serverAliveEnabled: true, serverAliveInterval: 15, serverAliveCountMax: 3 };
  const { api, calls } = recordingClient([{ status: 200, body: settings }, { status: 200, body: settings }]);
  assert.deepEqual(await api.getSshSettings(), settings);
  assert.deepEqual(await api.setSshSettings(settings), settings);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [
    'GET /v2/ssh/settings',
    'PUT /v2/ssh/settings',
  ]);
  assert.deepEqual(calls[1].body, settings);
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
  await api.uploadRemoteChunk('c 1', '/srv/up.bin', 8, new Uint8Array([0, 1, 2]), true);
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
  assert.deepEqual([...calls[8].body], [0, 1, 2]);
  assert.equal(calls[8].headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(calls[8].url.searchParams.get('path'), '/srv/up.bin');
  assert.equal(calls[8].url.searchParams.get('offset'), '8');
  assert.equal(calls[8].url.searchParams.get('overwrite'), 'true');
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

test('agent desktop routes use the contract paths, methods and bodies', async () => {
  const { api, calls } = recordingClient();
  await api.getAgentDesktop();
  await api.setAgentDesktopEnabled(true);
  await api.setAgentComputerEnabled(false);
  await api.revokeAgentDesktop('conv/1');
  await api.getAgentShot('conv/1', 'shot_1');
  await api.requestComputerPermissions();
  await api.getComputerFrame('conv/1');
  await api.getBrowserFrame('conv/1');
  await api.installAgentBrowser();
  await api.getAgentBrowserProfiles();
  await api.createAgentBrowserProfile('Shared');
  await api.renameAgentBrowserProfile('p/1', 'Main');
  await api.deleteAgentBrowserProfile('p/1');
  await api.assignAgentBrowserProfile('ws_1', 'p1');
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname, call.body]), [
    ['GET', '/v2/agent-desktop', undefined],
    ['PUT', '/v2/agent-desktop', { enabled: true }],
    ['PUT', '/v2/agent-desktop', { computerEnabled: false }],
    ['DELETE', '/v2/conversations/conv%2F1/agent-desktop', undefined],
    ['GET', '/v2/conversations/conv%2F1/agent-shots/shot_1', undefined],
    ['POST', '/v2/agent-desktop/computer/permissions', undefined],
    ['GET', '/v2/conversations/conv%2F1/agent-desktop/frame', undefined],
    ['GET', '/v2/conversations/conv%2F1/agent-desktop/frame', undefined],
    ['POST', '/v2/agent-browser/install', undefined],
    ['GET', '/v2/agent-browser/profiles', undefined],
    ['POST', '/v2/agent-browser/profiles', { name: 'Shared' }],
    ['PUT', '/v2/agent-browser/profiles/p%2F1', { name: 'Main' }],
    ['DELETE', '/v2/agent-browser/profiles/p%2F1', undefined],
    ['PUT', '/v2/agent-browser/workspaces', { workspace: 'ws_1', profileId: 'p1' }],
  ]);
  assert.equal(calls[7].url.search, '?capability=browser');
});

test('SSH forward and IP pool routes use the contract paths, methods and bodies', async () => {
  const { api, calls } = recordingClient();
  const forward = { alias: 'prod', kind: 'local', bindAddress: '127.0.0.1', bindPort: 8080, targetHost: 'localhost', targetPort: 80 };
  const pool = { enabled: true, cidr: '127.77.0.0/24', idleMinutes: 15 };
  await api.listSshForwards();
  await api.createSshForward(forward);
  await api.updateSshForward('f/1', forward);
  await api.deleteSshForward('f/1');
  await api.startSshForward('f/1');
  await api.startSshForward('f/1', 'secret');
  await api.stopSshForward('f/1');
  await api.getSshIpPool();
  await api.updateSshIpPool(pool);
  await api.createSshIpAssignment({ alias: 'prod', portMode: 'auto' });
  await api.updateSshIpAssignment('127.77.0.2', { portMode: 'manual', ports: ['8080', '7000-7010'] });
  await api.deleteSshIpAssignment('127.77.0.2');
  await api.connectSshIpAssignment('127.77.0.2');
  await api.connectSshIpAssignment('127.77.0.2', 'secret');
  await api.disconnectSshIpAssignment('127.77.0.2');
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname, call.body]), [
    ['GET', '/v2/ssh/forwards', undefined],
    ['POST', '/v2/ssh/forwards', forward],
    ['PUT', '/v2/ssh/forwards/f%2F1', forward],
    ['DELETE', '/v2/ssh/forwards/f%2F1', undefined],
    ['POST', '/v2/ssh/forwards/f%2F1/start', undefined],
    ['POST', '/v2/ssh/forwards/f%2F1/start', { password: 'secret' }],
    ['POST', '/v2/ssh/forwards/f%2F1/stop', undefined],
    ['GET', '/v2/ssh/ip-pool', undefined],
    ['PUT', '/v2/ssh/ip-pool', pool],
    ['POST', '/v2/ssh/ip-pool/assignments', { alias: 'prod', portMode: 'auto' }],
    ['PUT', '/v2/ssh/ip-pool/assignments/127.77.0.2', { portMode: 'manual', ports: ['8080', '7000-7010'] }],
    ['DELETE', '/v2/ssh/ip-pool/assignments/127.77.0.2', undefined],
    ['POST', '/v2/ssh/ip-pool/assignments/127.77.0.2/connect', undefined],
    ['POST', '/v2/ssh/ip-pool/assignments/127.77.0.2/connect', { password: 'secret' }],
    ['POST', '/v2/ssh/ip-pool/assignments/127.77.0.2/disconnect', undefined],
  ]);
});

test('parseSshPortSpec expands, dedupes, sorts and limits port entries', () => {
  assert.deepEqual(ssh.parseSshPortSpec(['8080', ' 3000-3002 ', '3001', '']), { ports: [3000, 3001, 3002, 8080] });
  assert.deepEqual(ssh.parseSshPortSpec([]), { ports: [] });
  assert.deepEqual(ssh.parseSshPortSpec(['1', '65535']), { ports: [1, 65535] });
  for (const bad of ['0', '65536', 'http', '80a', '10-5', '1-', '-5', '1-2-3', '1.5']) {
    assert.ok('error' in ssh.parseSshPortSpec([bad]), bad);
  }
  assert.equal(ssh.parseSshPortSpec(['1-4096']).ports.length, 4096);
  assert.ok('error' in ssh.parseSshPortSpec(['1-4096', '5000']));
  assert.ok('error' in ssh.parseSshPortSpec(['1-20'], 10));
  assert.deepEqual(ssh.parseSshPortSpec(['1-10', '5-10'], 10), { ports: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
});

test('port counting, listener memory and bind address helpers', () => {
  assert.equal(ssh.countSshPorts(['80', '8000-8100', '8050']), 102);
  assert.equal(ssh.countSshPorts(['nope']), 0);
  assert.equal(ssh.countSshPorts(['1-65535']), 65535);
  assert.equal(ssh.estimateSshListenerBytes(10), 10 * ssh.SSH_IP_BYTES_PER_LISTENER);
  assert.equal(ssh.estimateSshListenerBytes(-1), 0);
  assert.ok(ssh.isLoopbackBindAddress('127.0.0.1'));
  assert.ok(ssh.isLoopbackBindAddress('::1'));
  assert.ok(ssh.isLoopbackBindAddress(' LocalHost '));
  assert.ok(!ssh.isLoopbackBindAddress('0.0.0.0'));
  assert.ok(!ssh.isLoopbackBindAddress(undefined));
  assert.equal(ssh.formatSshHostPort('::1', 22), '[::1]:22');
  assert.equal(ssh.formatSshHostPort('127.0.0.1', 22), '127.0.0.1:22');
  assert.deepEqual(ssh.SSH_IP_POOL_IDLE_MINUTES_RANGE, { min: 1, max: 1440 });
  assert.equal(ssh.SSH_IP_POOL_DEFAULT_IDLE_MINUTES, 15);
  assert.equal(ssh.SSH_FORWARD_RUN_LIMIT, 32);
  assert.equal(ssh.SSH_IP_MANUAL_PORT_LIMIT, 4096);
});

test('validateSshIpPoolCidr mirrors the backend pool range rules', () => {
  assert.equal(ssh.validateSshIpPoolCidr('127.77.0.0/24'), null);
  assert.equal(ssh.validateSshIpPoolCidr(' 127.200.0.0/16 '), null);
  assert.equal(ssh.validateSshIpPoolCidr('127.77.0.4/30'), null);
  for (const bad of ['', '127.77.0.0', '127.77.0/24', '127.300.0.0/24', '127.77.0.0/33', 'abc/24']) {
    assert.equal(ssh.validateSshIpPoolCidr(bad), 'format', bad);
  }
  assert.equal(ssh.validateSshIpPoolCidr('10.0.0.0/24'), 'outsideLoopback');
  assert.equal(ssh.validateSshIpPoolCidr('127.0.0.0/8'), 'prefix');
  assert.equal(ssh.validateSshIpPoolCidr('127.77.0.0/15'), 'prefix');
  assert.equal(ssh.validateSshIpPoolCidr('127.77.0.0/31'), 'prefix');
  assert.equal(ssh.validateSshIpPoolCidr('127.77.0.1/24'), 'hostBits');
  assert.equal(ssh.validateSshIpPoolCidr('127.0.0.0/24'), 'containsLocalhost');
  assert.equal(ssh.validateSshIpPoolCidr('127.0.0.0/16'), 'containsLocalhost');
  assert.equal(ssh.validateSshIpPoolCidr('127.0.1.0/24'), null);
});
