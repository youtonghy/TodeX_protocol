const assert = require('node:assert/strict');

const {
  approvalResponsePayload,
  extractThreadIdFromEvent,
  inferApprovalResponseType,
  normalizeThreadId,
} = require('../dist/protocol-check/todex.js');

const cases = [
  [
    {
      type: 'codex.control.response',
      payload: {
        data: {
          requestId: 'thread-start-1',
          result: { thread: { id: 'thread_nested_1' } },
        },
      },
    },
    'thread_nested_1',
  ],
  [
    {
      type: 'codex.control.response',
      payload: {
        requestId: 'thread-start-2',
        result: { id: 'thread_result_id' },
      },
    },
    'thread_result_id',
  ],
  [
    {
      type: 'codex.thread.started',
      codex_thread_id: 'thread_event_id',
      payload: {},
    },
    'thread_event_id',
  ],
  [
    {
      type: 'codex.thread.started',
      payload: { thread_id: 'thread_payload_id' },
    },
    'thread_payload_id',
  ],
];

for (const [event, expected] of cases) {
  assert.equal(extractThreadIdFromEvent(event), expected);
}

assert.equal(normalizeThreadId(' thread_1 '), 'thread_1');

const permissionRequest = {
  requestId: 'permission-1',
  requestType: 'codex.approval.permissions.request',
  title: 'permission approval',
  event: { type: 'codex.approval.permissions.request', payload: {} },
  data: {
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ['/tmp/input'], write: ['/tmp/output'] },
    },
  },
};

assert.equal(inferApprovalResponseType(permissionRequest.requestType), 'codex.approval.permissions.respond');
assert.deepEqual(approvalResponsePayload(permissionRequest, true), {
  permissions: permissionRequest.data.permissions,
  scope: 'turn',
  strictAutoReview: false,
});
assert.deepEqual(approvalResponsePayload(permissionRequest, false), {
  permissions: {},
  scope: 'turn',
  strictAutoReview: false,
});

const commandRequest = {
  requestId: 'command-1',
  requestType: 'codex.approval.commandExecution.request',
  title: 'command approval',
  event: { type: 'codex.approval.commandExecution.request', payload: {} },
  data: {},
};

assert.deepEqual(approvalResponsePayload(commandRequest, true), { decision: 'accept' });
assert.deepEqual(approvalResponsePayload(commandRequest, false), { decision: 'decline' });

const elicitationRequest = {
  requestId: 'elicitation-1',
  requestType: 'codex.mcp.elicitation.request',
  title: 'elicitation',
  event: { type: 'codex.mcp.elicitation.request', payload: {} },
  data: {},
};

assert.equal(inferApprovalResponseType(elicitationRequest.requestType), 'codex.mcp.elicitation.respond');
assert.deepEqual(approvalResponsePayload(elicitationRequest, false), {
  action: 'decline',
  content: {},
  _meta: null,
});

console.log('protocol helpers ok');
