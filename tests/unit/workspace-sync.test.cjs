const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const todex = require(path.join(compiledDir, 'lib', 'todex.js'));

function workspace(overrides = {}) {
  return {
    id: 'ws_1',
    name: 'App',
    path: '/repo/app',
    sessionId: 'cdxs_ws_1',
    tenantId: 'local',
    threadId: '',
    model: 'gpt-5.5',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

test('parseWorkspaceSyncRejected reads the rejected list', () => {
  const rejected = todex.parseWorkspaceSyncRejected({
    workspaces: [],
    rejected: [
      { id: 'ws_1', name: 'Gone', path: '/repo/gone', code: 'WORKSPACE_PATH_NOT_FOUND', message: 'workspace path does not exist' },
      { path: '' },
      'nope',
    ],
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 'WORKSPACE_PATH_NOT_FOUND');
  assert.equal(rejected[0].path, '/repo/gone');
  assert.deepEqual(todex.parseWorkspaceSyncRejected({}), []);
  assert.deepEqual(todex.parseWorkspaceSyncRejected(null), []);
});

test('pathMissing survives normalization but is stripped from sync payloads', () => {
  const normalized = todex.normalizeWorkspaceRecord(workspace({ pathMissing: true }));
  assert.equal(normalized.pathMissing, true);
  const payload = todex.prepareWorkspaceSyncPayload([normalized]);
  assert.equal(payload[0].pathMissing, undefined);
});

test('workspace tombstones suppress matching stale remote records only', () => {
  const tombstone = todex.normalizeWorkspaceTombstone({
    id: 'ws_1',
    path: '/repo/app/',
    backendConnectionId: 'backend-1',
    deletedAt: 100,
  });
  assert.equal(tombstone.id, 'ws_1');
  assert.equal(tombstone.deletedAt, 100);

  assert.equal(todex.workspaceMatchesTombstone(workspace({ id: 'ws_9', path: '/repo/app', updatedAt: 50 }), tombstone), true);
  assert.equal(todex.workspaceMatchesTombstone(workspace({ id: 'other', path: '/repo/app/', updatedAt: 99 }), tombstone), true);
  // Recreated remotely after the deletion: newer updatedAt wins.
  assert.equal(todex.workspaceMatchesTombstone(workspace({ updatedAt: 101 }), tombstone), false);
  // Different path and id.
  assert.equal(todex.workspaceMatchesTombstone(workspace({ id: 'ws_2', path: '/repo/other', updatedAt: 10 }), tombstone), false);

  assert.equal(todex.normalizeWorkspaceTombstone({ path: '' }), null);
  assert.equal(todex.normalizeWorkspaceTombstone({ path: '/x' }), null);
  assert.equal(todex.normalizeWorkspaceTombstone('nope'), null);
});
