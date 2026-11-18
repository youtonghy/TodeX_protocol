const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { describeToolCall, summarizeToolActions } = require(path.join(compiledDir, 'lib', 'toolPresentation.js'));

const describe = (value) => describeToolCall(JSON.stringify(value));

test('pi and acp snapshots expose name, key argument and output', () => {
  const pi = describe({
    toolName: 'bash',
    arguments: { command: 'ls -la\necho done' },
    result: { content: [{ type: 'text', text: 'file.txt' }] },
    isError: false,
  });
  assert.equal(pi.name, 'bash');
  assert.equal(pi.summary, 'ls -la');
  assert.match(pi.argsText, /"command"/);
  assert.equal(pi.outputText, 'file.txt');
  assert.equal(pi.status, 'completed');

  const acp = describe({ toolCallId: 'c1', toolName: 'read', title: 'Read notes.md', status: 'in_progress', tool: { kind: 'read' } });
  assert.equal(acp.name, 'read');
  assert.equal(acp.summary, 'Read notes.md');
  assert.equal(acp.status, 'running');

  assert.equal(describe({ toolName: 'bash', arguments: { command: 'false' }, result: 'boom', isError: true }).status, 'failed');
});

test('claude tool_use blocks read the nested tool record', () => {
  const claude = describe({ provider: 'claude-code', tool: { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } } });
  assert.equal(claude.name, 'Read');
  assert.equal(claude.summary, '/repo/a.ts');
  assert.equal(claude.status, 'unknown');

  const question = describe({ toolName: 'AskUserQuestion', arguments: { questions: [{ question: 'Which color?' }, { question: 'Which fruits?' }] } });
  assert.equal(question.summary, 'Which color? / Which fruits?');
});

test('antigravity snapshots read its PascalCase arguments', () => {
  const command = describe({ provider: 'antigravity', toolCallId: 'call_3737294271069237793', toolName: 'run_command', arguments: { CommandLine: 'git status --short', WaitMsBeforeAsync: 5000 }, result: { output: 'M a.ts', exit_code: 0 }, status: 'completed', isError: false });
  assert.equal(command.name, 'run_command');
  assert.equal(command.summary, 'git status --short');
  assert.equal(command.status, 'completed');

  const write = describe({ provider: 'antigravity', toolCallId: 'call_1', toolName: 'write_file', arguments: { Content: 'hi', Path: '/repo/hello.txt' }, status: 'failed', isError: true });
  assert.equal(write.summary, '/repo/hello.txt');
  assert.equal(write.status, 'failed');

  assert.equal(describe({ toolName: 'view_file', arguments: { AbsolutePath: '/repo/a.ts' } }).summary, '/repo/a.ts');
  assert.equal(describe({ toolName: 'write_to_file', arguments: { TargetFile: '/repo/b.ts', CodeContent: 'x' } }).summary, '/repo/b.ts');
  assert.equal(describe({ toolName: 'list_dir', arguments: { DirectoryPath: '/repo/src' } }).summary, '/repo/src');
});

test('codex items map to kinds with their identifying field', () => {
  const command = describe({ type: 'commandExecution', id: 'i1', command: 'pnpm test', cwd: '/repo', status: 'completed', exitCode: 1, aggregatedOutput: 'fail' });
  assert.equal(command.kind, 'command');
  assert.equal(command.name, '');
  assert.equal(command.summary, 'pnpm test');
  assert.equal(command.outputText, 'fail');
  assert.equal(command.status, 'failed');

  const change = describe({ type: 'fileChange', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }], status: 'completed' });
  assert.equal(change.kind, 'fileChange');
  assert.equal(change.summary, 'a.ts, b.ts');

  assert.equal(describe({ type: 'webSearch', query: 'heroui chat tool' }).summary, 'heroui chat tool');

  const mcp = describe({ type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'x' }, error: { message: 'denied' }, status: 'failed' });
  assert.equal(mcp.name, 'docs.search');
  assert.equal(mcp.summary, 'x');
  assert.equal(mcp.errorText, 'denied');
  assert.equal(mcp.status, 'failed');

  assert.equal(describe({ type: 'imageView', path: '/tmp/a.png' }).name, 'imageView');
});

test('plain text and empty stubs fall back without throwing', () => {
  assert.deepEqual(describeToolCall(''), { kind: 'tool', name: '', summary: '', argsText: '', status: 'unknown', action: 'other', targets: [] });
  const partial = describeToolCall('{"command": "ls');
  assert.equal(partial.name, '');
  assert.equal(partial.summary, '{"command": "ls');
  assert.equal(describe({ command: 'pwd' }).kind, 'command');
});

test('summaries stay single-line and details stay bounded', () => {
  const long = describe({ toolName: 'write', arguments: { path: 'x'.repeat(500), content: 'y'.repeat(20000) } });
  assert.ok(long.summary.length <= 161);
  assert.ok(long.argsText.length <= 8001);
});

test('a submitted plan is summarized by its first line', () => {
  const plan = describe({ provider: 'claude-code', tool: { type: 'tool_use', id: 't2', name: 'ExitPlanMode', input: { plan: '## 拆分构建脚本\n1. 拆出 color.ts' } } });
  assert.equal(plan.name, 'ExitPlanMode');
  assert.equal(plan.summary, '拆分构建脚本');
});

test('calls are recognized as actions across providers', () => {
  const action = (value) => describe(value).action;
  // Claude
  assert.equal(action({ tool: { type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } } }), 'read');
  assert.equal(action({ tool: { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/r/a.ts' } } }), 'edit');
  assert.equal(action({ tool: { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } } }), 'search');
  assert.equal(action({ tool: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } }), 'command');
  assert.equal(action({ tool: { type: 'tool_use', name: 'WebFetch', input: { url: 'https://a' } } }), 'web');
  assert.equal(action({ tool: { type: 'tool_use', name: 'Task', input: { prompt: 'p' } } }), 'agent');
  assert.equal(action({ tool: { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'p' } } }), 'other');
  // Pi
  assert.equal(action({ toolName: 'read', arguments: { path: 'a.ts' } }), 'read');
  assert.equal(action({ toolName: 'bash', arguments: { command: 'ls' } }), 'command');
  // Antigravity
  assert.equal(action({ toolName: 'view_file', arguments: { AbsolutePath: '/r/a.ts' } }), 'read');
  assert.equal(action({ toolName: 'write_to_file', arguments: { TargetFile: '/r/b.ts' } }), 'edit');
  assert.equal(action({ toolName: 'run_command', arguments: { CommandLine: 'ls' } }), 'command');
  assert.equal(action({ toolName: 'search_web', arguments: { query: 'q' } }), 'web');
  // Codex
  assert.equal(action({ type: 'commandExecution', command: 'ls' }), 'command');
  assert.equal(action({ type: 'fileChange', changes: [] }), 'edit');
  assert.equal(action({ type: 'webSearch', query: 'q' }), 'web');
  assert.equal(action({ type: 'imageView', path: '/tmp/a.png' }), 'read');
  // ACP kind is the fallback for unknown names; Agent Calling tools start agents.
  assert.equal(action({ toolName: 'mystery', tool: { kind: 'execute' } }), 'command');
  assert.equal(action({ toolName: 'mcp__todex_agents__agent_run', arguments: {} }), 'agent');
  assert.equal(action({ toolName: 'mcp__docs__lookup', arguments: {} }), 'other');
});

test('read and edit calls name the files they touch', () => {
  assert.deepEqual(describe({ tool: { type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'x' } } }).targets, ['/r/a.ts']);
  assert.deepEqual(describe({ toolName: 'view_file', arguments: { AbsolutePath: '/r/a.ts' } }).targets, ['/r/a.ts']);
  assert.deepEqual(describe({ toolName: 'read', title: 'Read notes.md', tool: { kind: 'read' }, locations: [{ path: '/r/notes.md' }] }).targets, ['/r/notes.md']);
  assert.deepEqual(describe({ type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'a.ts' }] }).targets, ['a.ts', 'b.ts']);
  assert.deepEqual(describe({ type: 'imageView', path: '/tmp/a.png' }).targets, ['/tmp/a.png']);
  assert.deepEqual(describe({ toolName: 'bash', arguments: { command: 'cat a.ts' } }).targets, []);
});

test('a run is summarized by action, counting distinct files', () => {
  const calls = [
    { action: 'read', targets: ['a.ts'] },
    { action: 'read', targets: ['a.ts'] },
    { action: 'read', targets: ['b.ts'] },
    { action: 'command', targets: [] },
    { action: 'edit', targets: ['a.ts', 'c.ts'] },
    { action: 'read', targets: [] },
    { action: 'command', targets: [] },
  ];
  assert.deepEqual(summarizeToolActions(calls), [
    { action: 'edit', count: 2 },
    { action: 'command', count: 2 },
    { action: 'read', count: 3 },
  ]);
  assert.deepEqual(summarizeToolActions([]), []);
});
