const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { describeToolCall } = require(path.join(compiledDir, 'lib', 'toolPresentation.js'));

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
  assert.deepEqual(describeToolCall(''), { kind: 'tool', name: '', summary: '', argsText: '', status: 'unknown' });
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
