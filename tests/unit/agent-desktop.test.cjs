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

test('tunnel flow-control constants keep frames far below the socket limit', () => {
  const encodedChunk = Math.ceil(desktop.TUNNEL_CHUNK_BYTES / 3) * 4;
  assert.ok(encodedChunk < 64 * 1024);
  assert.ok(desktop.TUNNEL_WINDOW_BYTES >= desktop.TUNNEL_CHUNK_BYTES * 4);
});
