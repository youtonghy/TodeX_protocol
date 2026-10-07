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

test('icon and iconColor survive normalization and sync payloads', () => {
  const normalized = todex.normalizeWorkspaceRecord(
    workspace({ icon: 'rocket', iconColor: '#3B82F6', ringStyle: 'beads' }),
  );
  assert.equal(normalized.icon, 'rocket');
  assert.equal(normalized.iconColor, '#3b82f6');
  assert.equal(normalized.ringStyle, 'beads');
  const payload = todex.prepareWorkspaceSyncPayload([normalized]);
  assert.equal(payload[0].icon, 'rocket');
  assert.equal(payload[0].iconColor, '#3b82f6');
  assert.equal(payload[0].ringStyle, 'beads');

  const invalid = todex.normalizeWorkspaceRecord(
    workspace({ icon: '   ', iconColor: 'blue', ringStyle: '  ' }),
  );
  assert.equal(invalid.icon, undefined);
  assert.equal(invalid.iconColor, undefined);
  assert.equal(invalid.ringStyle, undefined);
});

test('merge keeps a local icon when the remote record lacks one', () => {
  const local = todex.normalizeWorkspaceRecord(
    workspace({ icon: 'rocket', iconColor: '#3b82f6', ringStyle: 'pulse', updatedAt: 20 }),
  );
  const remote = todex.normalizeWorkspaceRecord(workspace({ updatedAt: 30 }));
  const [merged] = todex.mergeWorkspaceRecords([local], [remote]);
  assert.equal(merged.icon, 'rocket');
  assert.equal(merged.iconColor, '#3b82f6');
  assert.equal(merged.ringStyle, 'pulse');
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

test('normalizeWorkspaceRecord keeps trimmed group fields', () => {
  const record = todex.normalizeWorkspaceRecord(workspace({ group_id: ' wsg_1 ', groupName: ` ${'x'.repeat(80)} ` }));
  assert.equal(record.groupId, 'wsg_1');
  assert.equal(record.groupName.length, todex.WORKSPACE_GROUP_FIELD_MAX);
  assert.equal(todex.normalizeWorkspaceRecord(workspace({ groupId: '  ' })).groupId, undefined);
});

test('mergeWorkspaceRecords lets a newer record clear its group', () => {
  const local = [workspace({ groupId: 'wsg_1', groupName: 'App', updatedAt: 20 })];
  const remote = [workspace({ updatedAt: 30 })];
  const [merged] = todex.mergeWorkspaceRecords(local, remote);
  assert.equal(merged.groupId, undefined);
  assert.equal(merged.groupName, undefined);
  const [kept] = todex.mergeWorkspaceRecords([workspace({ groupId: 'wsg_1', updatedAt: 40 })], remote);
  assert.equal(kept.groupId, 'wsg_1');
});

function layout(entries) {
  return entries.map((entry) => (entry.kind === 'workspace'
    ? entry.workspace.id
    : `${entry.name}[${entry.workspaces.map((item) => item.id).join(',')}]`));
}

function sample() {
  return todex.groupWorkspaceEntries([
    workspace({ id: 'a', name: 'TJXY', path: '/a' }),
    workspace({ id: 'b', name: 'Todex', path: '/b', groupId: 'g1', groupName: 'Old', updatedAt: 10 }),
    workspace({ id: 'c', name: 'Other', path: '/c' }),
    workspace({ id: 'd', name: 'Todex_test', path: '/d', groupId: 'g1', groupName: 'Todex', updatedAt: 50 }),
    workspace({ id: 'e', name: 'TJXY_app', path: '/e', groupId: 'lonely' }),
  ]);
}

test('groupWorkspaceEntries places a group at its first member and dissolves singletons', () => {
  assert.deepEqual(layout(sample()), ['a', 'Todex[b,d]', 'c', 'e']);
});

test('moveWorkspaceEntry merges, joins, reorders, and leaves groups', () => {
  const fresh = { id: 'g2', fallbackName: 'New group' };
  const merged = todex.moveWorkspaceEntry(sample(), { kind: 'workspace', id: 'e' }, { kind: 'workspace', id: 'a', position: 'merge' }, fresh);
  assert.deepEqual(layout(merged), ['TJXY[a,e]', 'Todex[b,d]', 'c']);
  const unnamed = todex.moveWorkspaceEntry(sample(), { kind: 'workspace', id: 'c' }, { kind: 'workspace', id: 'a', position: 'merge' }, fresh);
  assert.equal(unnamed[0].name, 'New group');
  const joined = todex.moveWorkspaceEntry(sample(), { kind: 'workspace', id: 'c' }, { kind: 'group', id: 'g1', position: 'into' }, fresh);
  assert.deepEqual(layout(joined), ['a', 'Todex[b,d,c]', 'e']);
  const inside = todex.moveWorkspaceEntry(sample(), { kind: 'workspace', id: 'a' }, { kind: 'workspace', id: 'b', position: 'before' }, fresh);
  assert.deepEqual(layout(inside), ['Todex[a,b,d]', 'c', 'e']);
  const out = todex.moveWorkspaceEntry(sample(), { kind: 'workspace', id: 'd' }, { kind: 'workspace', id: 'e', position: 'after' }, fresh);
  assert.deepEqual(layout(out), ['a', 'b', 'c', 'e', 'd']);
  const groupMoved = todex.moveWorkspaceEntry(sample(), { kind: 'group', id: 'g1' }, { kind: 'workspace', id: 'e', position: 'after' }, fresh);
  assert.deepEqual(layout(groupMoved), ['a', 'c', 'e', 'Todex[b,d]']);
  const nested = todex.moveWorkspaceEntry(sample(), { kind: 'group', id: 'g1' }, { kind: 'workspace', id: 'a', position: 'merge' }, fresh);
  assert.deepEqual(layout(nested), layout(sample()));
});

test('group menu operations and layout patches', () => {
  assert.deepEqual(layout(todex.removeWorkspaceFromGroup(sample(), 'b')), ['a', 'd', 'b', 'c', 'e']);
  assert.deepEqual(layout(todex.ungroupWorkspaceGroup(sample(), 'g1')), ['a', 'b', 'd', 'c', 'e']);
  assert.deepEqual(layout(todex.moveWorkspaceToGroup(sample(), 'a', 'g1')), ['Todex[b,d,a]', 'c', 'e']);
  assert.deepEqual(layout(todex.groupWorkspacesTogether(sample(), 'c', 'a', { id: 'g2', fallbackName: 'N' })), ['Todex[b,d]', 'N[c,a]', 'e']);
  assert.equal(todex.renameWorkspaceGroup(sample(), 'g1', '  ')[1].name, 'Todex');

  const patches = todex.workspaceLayoutPatches(todex.renameWorkspaceGroup(sample(), 'g1', 'Core'));
  assert.deepEqual(patches.map((item) => [item.id, item.patch.sortOrder, item.patch.groupId, item.patch.groupName]), [
    ['a', 0, undefined, undefined],
    ['b', 1, 'g1', 'Core'],
    ['d', 2, 'g1', 'Core'],
    ['c', 3, undefined, undefined],
    ['e', 4, undefined, undefined],
  ]);
  const settled = todex.groupWorkspaceEntries([
    workspace({ id: 'a', path: '/a', sortOrder: 0 }),
    workspace({ id: 'b', path: '/b', sortOrder: 1 }),
  ]);
  assert.deepEqual(todex.workspaceLayoutPatches(settled), []);
});

test('suggestWorkspaceGroupName uses the shared prefix', () => {
  assert.equal(todex.suggestWorkspaceGroupName('TJXY', 'TJXY_app', 'N'), 'TJXY');
  assert.equal(todex.suggestWorkspaceGroupName('todex-web', 'Todex-desktop', 'N'), 'todex');
  assert.equal(todex.suggestWorkspaceGroupName('blog', 'notes', 'N'), 'N');
  assert.match(todex.newWorkspaceGroupId(), /^wsg_[0-9a-f-]{36}$/);
});
