const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { ConnectionError, isConflictError } = require(path.join(compiledDir, 'lib', 'connectionError.js'));

test('apiRequestFailed carries the HTTP status and backend code', () => {
  const error = ConnectionError.apiRequestFailed(409, 'CONFLICT', 'file changed since it was opened; reload before saving');
  assert.equal(error.httpStatus, 409);
  assert.equal(error.backendCode, 'CONFLICT');
  assert.match(error.technicalDetails, /HTTP 409/);
  assert.match(error.technicalDetails, /CONFLICT/);
});

test('isConflictError matches the mobile CONFLICT/409 semantics', () => {
  assert.equal(isConflictError(ConnectionError.apiRequestFailed(409, 'CONFLICT')), true);
  assert.equal(isConflictError(ConnectionError.apiRequestFailed(409)), true);
  assert.equal(isConflictError(ConnectionError.apiRequestFailed(200, 'CONFLICT')), true);
  assert.equal(isConflictError(ConnectionError.apiRequestFailed(400, 'INVALID_REQUEST')), false);
  assert.equal(isConflictError(ConnectionError.apiRequestFailed(500, 'CONFLICT')), true);
  assert.equal(isConflictError(new Error('nope')), false);
  assert.equal(isConflictError(null), false);
});

test('apiRequestFailed keeps backend-specific mappings', () => {
  const outside = ConnectionError.apiRequestFailed(403, 'WORKSPACE_PATH_OUTSIDE_ROOT', 'nope');
  assert.equal(outside.userMessage, '工作区目录不在 Backend 允许的根目录内');
  assert.equal(outside.httpStatus, 403);
  assert.equal(outside.backendCode, 'WORKSPACE_PATH_OUTSIDE_ROOT');
  assert.equal(isConflictError(outside), false);

  const provider = ConnectionError.apiRequestFailed(503, 'PROVIDER_UNAVAILABLE', 'down');
  assert.equal(provider.type, 'PROVIDER_UNAVAILABLE');
  assert.equal(provider.httpStatus, 503);
  assert.equal(provider.backendCode, 'PROVIDER_UNAVAILABLE');
});

test('apiRequestFailed explains the forced history encryption conflicts', () => {
  const readOnly = ConnectionError.apiRequestFailed(409, 'HISTORY_READ_ONLY', 'legacy');
  assert.match(readOnly.userMessage, /旧版未加密/);
  assert.equal(readOnly.backendCode, 'HISTORY_READ_ONLY');
  assert.equal(readOnly.retryable, false);
  const keyRequired = ConnectionError.apiRequestFailed(409, 'HISTORY_KEY_REQUIRED', 'no recipient');
  assert.match(keyRequired.userMessage, /历史密钥/);
  assert.equal(keyRequired.backendCode, 'HISTORY_KEY_REQUIRED');
});

test('authenticationFailed records the HTTP status', () => {
  const error = ConnectionError.authenticationFailed(401);
  assert.equal(error.httpStatus, 401);
  assert.equal(isConflictError(error), false);
});

test('only 401 / UNAUTHENTICATED count as an authentication failure', () => {
  const { isAuthenticationFailure, parseBackendErrorBody } = require(path.join(compiledDir, 'lib', 'connectionError.js'));
  assert.equal(isAuthenticationFailure(401), true);
  assert.equal(isAuthenticationFailure(400, 'UNAUTHENTICATED'), true);
  assert.equal(isAuthenticationFailure(401, 'REMOTE_AUTH_FAILED'), false);
  assert.equal(isAuthenticationFailure(403), false);
  assert.equal(isAuthenticationFailure(403, 'UNAUTHORIZED'), false);
  assert.deepEqual(parseBackendErrorBody(new TextEncoder().encode('{"code":"UNAUTHORIZED","message":"nope"}')), { code: 'UNAUTHORIZED', message: 'nope' });
  assert.equal(parseBackendErrorBody(new TextEncoder().encode('not json')), null);
  assert.equal(parseBackendErrorBody(undefined), null);
});

test('authenticationFailed carries a locale-neutral fallback message', () => {
  const error = ConnectionError.authenticationFailed(401);
  assert.equal(error.code, 'authentication_failed');
  assert.doesNotMatch(error.userMessage, /[一-鿿]/);
});

test('a 403 permission refusal keeps the server message', () => {
  const error = ConnectionError.apiRequestFailed(403, 'UNAUTHORIZED', 'device lacks the admin role');
  assert.equal(error.code, 'request_failed');
  assert.equal(error.userMessage, 'device lacks the admin role');
  assert.equal(error.httpStatus, 403);
});

function fakeTransport(responses) {
  return {
    fetch: async request => {
      const entry = responses[request.path];
      return { status: entry.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(entry.body ?? {})) };
    },
  };
}

test('probeBackendConnection separates 401 from 403', async () => {
  const { probeBackendConnection } = require(path.join(compiledDir, 'lib', 'connectionProbe.js'));
  const unauthenticated = await probeBackendConnection({
    serverUrl: 'http://127.0.0.1:7345',
    transport: fakeTransport({ '/v2/version': { status: 401, body: { code: 'UNAUTHENTICATED', message: 'unsigned' } } }),
  });
  assert.equal(unauthenticated.code, 'authentication_failed');
  const forbidden = await probeBackendConnection({
    serverUrl: 'http://127.0.0.1:7345',
    transport: fakeTransport({ '/v2/version': { status: 403, body: { code: 'UNAUTHORIZED', message: 'device revoked by admin' } } }),
  });
  assert.equal(forbidden.code, 'request_failed');
  assert.equal(forbidden.error.userMessage, 'device revoked by admin');
  assert.equal(forbidden.error.httpStatus, 403);
});

test('probeBackendConnection keeps the server message for every non-OK status', async () => {
  const { probeBackendConnection } = require(path.join(compiledDir, 'lib', 'connectionProbe.js'));
  const probe = (status, body) => probeBackendConnection({
    serverUrl: 'http://127.0.0.1:7345',
    transport: fakeTransport({ '/v2/version': { status, body } }),
  });
  const rejected = await probe(400, { code: 'INVALID_REQUEST', message: 'bad header' });
  assert.equal(rejected.code, 'backend_unreachable');
  assert.equal(rejected.error.type, 'PROTOCOL_ERROR');
  assert.equal(rejected.error.userMessage, 'bad header');
  assert.equal(rejected.error.httpStatus, 400);
  assert.equal(rejected.error.backendCode, 'INVALID_REQUEST');
  const failed = await probe(500, { code: 'INTERNAL', message: 'disk full' });
  assert.equal(failed.code, 'backend_unreachable');
  assert.equal(failed.error.type, 'SERVER_ERROR');
  assert.match(failed.error.technicalDetails, /HTTP 500 · INTERNAL · disk full/);
  const missing = await probe(404, { code: 'NOT_FOUND', message: 'no such route' });
  assert.equal(missing.error.type, 'PROTOCOL_MISMATCH');
  assert.match(missing.error.technicalDetails, /no such route/);
  assert.equal(missing.error.httpStatus, 404);
  const bare = await probe(418, {});
  assert.equal(bare.error.userMessage, '请求失败，请检查网络连接');
});
