const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildGitAgentPrompt } = require('../../dist/unit/lib/gitAgentActions.js');

test('PR and handoff prompts preserve explicit workspace scope and non-destructive limits', () => {
  assert.throws(() => buildGitAgentPrompt('create-pr', { workspacePath: '  ' }));
  assert.match(buildGitAgentPrompt('create-pr', { workspacePath: '/repo\nwith-newline' }), /"\/repo\\nwith-newline"/);
  assert.match(buildGitAgentPrompt('create-pr', { workspacePath: '/repo' }), /不要自动合并 PR/);
  assert.match(buildGitAgentPrompt('handoff', { workspacePath: '/repo' }), /不要宣称已完成迁移/);
});
