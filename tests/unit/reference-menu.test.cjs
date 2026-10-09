const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const menu = require(path.join(__dirname, '../../dist/unit/lib/referenceMenu.js'));

test('parses the menu stage from the text after @', () => {
  assert.deepEqual(menu.referenceMenuState(''), { stage: 'type', prefix: '' });
  assert.deepEqual(menu.referenceMenuState('sk'), { stage: 'type', prefix: 'sk' });
  assert.deepEqual(menu.referenceMenuState('Skill:git'), { stage: 'item', type: 'skill', query: 'git' });
  assert.deepEqual(menu.referenceMenuState('folder:'), { stage: 'item', type: 'folder', query: '' });
  assert.deepEqual(menu.referenceMenuState('chat:a:b'), { stage: 'item', type: 'chat', query: 'a:b' });
  // Unknown prefixes and paths with colons stay a file search.
  assert.deepEqual(menu.referenceMenuState('foo:bar'), { stage: 'type', prefix: 'foo:bar' });
  assert.deepEqual(menu.referenceMenuState('src/a:b'), { stage: 'type', prefix: 'src/a:b' });
  assert.deepEqual(menu.referenceMenuState(':x'), { stage: 'type', prefix: ':x' });
});

test('lists types in a fixed order, narrowed by prefix', () => {
  const describe = (type) => `d-${type}`;
  assert.deepEqual(menu.buildReferenceTypeSuggestions('', describe).map((item) => item.label),
    ['@file:', '@folder:', '@chat:', '@skill:', '@mcp:', '@ssh:', '@app:']);
  assert.deepEqual(menu.buildReferenceTypeSuggestions('F', describe).map((item) => item.action.text), ['@file:', '@folder:']);
  assert.deepEqual(menu.buildReferenceTypeSuggestions('src/', describe), []);
  assert.equal(menu.buildReferenceTypeSuggestions('sk', describe)[0].description, 'd-skill');
});

test('entry suggestions insert the provider-facing @path per mode', () => {
  const entries = [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
  ];
  const texts = (mode) => menu.buildEntryReferenceSuggestions(entries, mode).map((item) => item.action.text);
  assert.deepEqual(texts(undefined), ['@src', '@src/a.ts ']);
  assert.deepEqual(texts('file'), ['@file:src/', '@src/a.ts ']);
  assert.deepEqual(texts('folder'), ['@src/ ']);
  assert.deepEqual(menu.buildEntryReferenceSuggestions(entries, 'folder').map((item) => item.label), ['@src/']);
});

test('chat suggestions list other unarchived conversations of the workspace', () => {
  const conversations = [
    { id: 'current', workspaceId: 'w', title: 'Fix build' },
    { id: 'a', workspaceId: 'w', title: 'Fix the Build', preview: 'line one\nline two' },
    { id: 'b', workspaceId: 'w', title: '' },
    { id: 'c', workspaceId: 'other', title: 'Fix build' },
    { id: 'd', workspaceId: 'w', title: 'Fix build', archived: true },
  ];
  assert.deepEqual(menu.buildChatReferenceSuggestions('thebuild', conversations, 'w', 'current', 'New'), [
    { id: 'chat:a', label: 'Fix the Build', description: 'line one line two', action: { kind: 'conversation', conversationId: 'a', title: 'Fix the Build' } },
  ]);
  assert.deepEqual(menu.buildChatReferenceSuggestions('', conversations, 'w', 'current', 'New').map((item) => item.label), ['Fix the Build', 'New']);
});

test('ssh suggestions list only agent-access hosts and insert an @ssh: mention', () => {
  const hosts = [
    { alias: 'prod', source: 'sshConfig', agentAccess: false, resolved: { hostName: 'prod.internal', user: 'deploy', identityFiles: [] } },
    { alias: 'dev-vm', source: 'managed', agentAccess: true, resolved: { hostName: '10.0.0.2', user: 'me', port: 2222, identityFiles: [] } },
  ];
  assert.deepEqual(menu.buildSshReferenceSuggestions('', hosts).map((item) => [item.label, item.description]), [
    ['dev-vm', 'me@10.0.0.2:2222'],
  ]);
  assert.deepEqual(menu.buildSshReferenceSuggestions('10.0', hosts).map((item) => item.label), ['dev-vm']);
  const dev = menu.buildSshReferenceSuggestions('dev', hosts)[0];
  assert.deepEqual(dev.action, { kind: 'insert', text: '@ssh:dev-vm ' });
  assert.deepEqual(menu.buildSshReferenceSuggestions('prod', hosts), []);
  assert.deepEqual(menu.buildSshReferenceSuggestions('none', hosts), []);
});

test('capability suggestions keep one kind', () => {
  const items = [
    { kind: 'skill', id: 'skill:1', name: 'review', description: 'Review', provider: 'codex', skill: {}, attached: false },
    { kind: 'mcp', id: 'mcp:1', name: 'github', description: 'stdio', provider: 'codex', server: {} },
  ];
  assert.deepEqual(menu.buildCapabilityReferenceSuggestions(items, 'mcp').map((item) => [item.label, item.action.item.id]), [['github', 'mcp:1']]);
  assert.deepEqual(menu.buildCapabilityReferenceSuggestions(items, 'skill').map((item) => item.label), ['review']);
});

test('app suggestions match name or id and insert an @app: id mention', () => {
  const apps = [
    { id: 'com.google.Chrome', name: 'Google Chrome', running: true },
    { id: 'com.apple.TextEdit', name: 'TextEdit', running: false },
  ];
  assert.deepEqual(menu.buildAppReferenceSuggestions('googlech', apps).map((item) => [item.label, item.description, item.action.text]), [
    ['Google Chrome', 'com.google.Chrome', '@app:com.google.Chrome '],
  ]);
  assert.deepEqual(menu.buildAppReferenceSuggestions('APPLE', apps).map((item) => item.id), ['app:com.apple.TextEdit']);
  assert.deepEqual(menu.buildAppReferenceSuggestions('', apps, (app) => (app.running ? 'on' : 'off')).map((item) => item.description), ['on', 'off']);
  assert.equal(menu.referenceMenuState('app:text').type, 'app');
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, name: `A${index}`, running: false }));
  assert.equal(menu.buildAppReferenceSuggestions('', many).length, menu.REFERENCE_SUGGESTION_LIMIT);
});
