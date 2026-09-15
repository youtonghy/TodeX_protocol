const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readGitWorkspace, runGitWorkspaceOperation, GitWorkspaceError } = require('../../dist/unit/lib/gitWorkspace.js');
const { buildGitAgentPrompt } = require('../../dist/unit/lib/gitAgentActions.js');
const settings = { serverUrl: 'http://localhost:3000', authToken: 'test-token' };

test('Git workspace read and mutation preserve the backend wire contract', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ repositoryPath: '/repo' }), { status: 200 }); };
  try {
    await readGitWorkspace(settings, '/repo with spaces');
    assert.equal(new URL(calls[0].url).pathname, '/v2/git/workspace');
    assert.equal(new URL(calls[0].url).searchParams.get('workspacePath'), '/repo with spaces');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
    await runGitWorkspaceOperation(settings, '/repo', { action: 'create-worktree', branchName: 'codex/task', path: '/new' });
    assert.equal(new URL(calls[1].url).pathname, '/v2/git/operation');
    assert.equal(calls[1].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].init.body), { workspacePath: '/repo', operation: { action: 'create-worktree', branchName: 'codex/task', path: '/new' } });
  } finally { global.fetch = original; }
});

test('Git mutation network failure is uncertain and never retried automatically', async () => {
  const original = global.fetch;
  let attempts = 0;
  global.fetch = async () => { attempts++; throw new Error('connection reset'); };
  try {
    await assert.rejects(runGitWorkspaceOperation(settings, '/repo', { action: 'push' }), error => error instanceof GitWorkspaceError && error.unknownOutcome);
    assert.equal(attempts, 1);
    await assert.rejects(readGitWorkspace(settings, '/repo'), error => error instanceof GitWorkspaceError && !error.unknownOutcome);
  } finally { global.fetch = original; }
});

test('Git explicit rejection permits correction while partial success remains uncertain', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({ code: 'GIT_DIRTY', message: 'dirty' }), { status: 409 });
    await assert.rejects(runGitWorkspaceOperation(settings, '/repo', { action: 'switch-branch', branchName: 'main' }), error => !error.unknownOutcome && error.status === 409);
    global.fetch = async () => new Response(JSON.stringify({ code: 'GIT_PARTIAL_SUCCESS', message: 'partial' }), { status: 409 });
    await assert.rejects(runGitWorkspaceOperation(settings, '/repo', { action: 'push' }), error => error.unknownOutcome);
  } finally { global.fetch = original; }
});

test('PR and handoff prompts preserve explicit workspace scope and non-destructive limits', () => {
  assert.throws(() => buildGitAgentPrompt('create-pr', { workspacePath: '  ' }));
  assert.match(buildGitAgentPrompt('create-pr', { workspacePath: '/repo\nwith-newline' }), /"\/repo\\nwith-newline"/);
  assert.match(buildGitAgentPrompt('create-pr', { workspacePath: '/repo' }), /不要自动合并 PR/);
  assert.match(buildGitAgentPrompt('handoff', { workspacePath: '/repo' }), /不要宣称已完成迁移/);
});
