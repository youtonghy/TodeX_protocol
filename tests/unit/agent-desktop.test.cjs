const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const desktop = require(path.join(compiledDir, 'agentDesktop.js'));

test('agent browser tool names are MCP- and model-API-safe', () => {
  for (const tool of desktop.AGENT_BROWSER_TOOLS) {
    assert.match(tool, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(`mcp__${desktop.AGENT_DESKTOP_SERVER}__${tool}`.length <= 64);
    assert.ok(desktop.isAgentBrowserTool(tool));
  }
  assert.equal(desktop.isAgentBrowserTool('browser.open'), false);
  assert.equal(desktop.isAgentBrowserTool(undefined), false);
});

test('device-restricted permissions are answerable only on the named devices', () => {
  const { permissionDeviceGate } = require(path.join(compiledDir, 'todex.js'));
  const request = (data) => ({ requestId: 'p', requestType: 'permission', title: 't', event: {}, data });
  assert.deepEqual(permissionDeviceGate(request({ options: [] }), undefined), { allowed: true });
  const gated = request({
    allowedDeviceIds: ['dev_desk', 'dev_other'],
    details: { executors: [
      { deviceId: 'dev_desk', deviceName: 'Studio Mac' },
      { deviceId: 'dev_other' },
      { deviceId: 'dev_unlisted', deviceName: 'Nope' },
    ] },
  });
  assert.deepEqual(permissionDeviceGate(gated, 'dev_desk'), { allowed: true });
  assert.deepEqual(permissionDeviceGate(gated, 'dev_phone'), { allowed: false, deviceNames: ['Studio Mac', 'dev_other'] });
  assert.deepEqual(permissionDeviceGate(request({ allowedDeviceIds: ['dev_desk'] }), undefined), { allowed: false, deviceNames: [] });
});

test('permission summaries expose the full command and why the provider asked', () => {
  const { permissionRequestSummary } = require(path.join(compiledDir, 'todex.js'));
  const request = (details) => ({ requestId: 'p', requestType: 'permission', title: 't', event: {}, data: { details } });
  const command = 'L=/tmp/x && rm -f $L/*; cat $L/summary';
  assert.deepEqual(permissionRequestSummary(request({
    tool_name: 'Bash',
    command,
    reason: 'Dangerous rm operation',
    decision_reason_type: 'safetyCheck',
    input: { command, description: 'Run checks' },
  })), { tool: 'Bash', command, cwd: undefined, description: 'Run checks', reason: 'Dangerous rm operation', safetyCheck: true });
  assert.equal(permissionRequestSummary(request({ command: ['git', 'status'], cwd: '/repo' })).command, 'git status');
  assert.deepEqual(permissionRequestSummary({ ...request(undefined), data: {} }), {
    tool: undefined, command: undefined, cwd: undefined, description: undefined, reason: undefined, safetyCheck: false,
  });
});

test('computer tool names are MCP- and model-API-safe', () => {
  for (const tool of desktop.AGENT_COMPUTER_TOOLS) {
    assert.match(tool, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(desktop.isAgentComputerTool(tool));
    assert.equal(desktop.isAgentBrowserTool(tool), false);
  }
});
