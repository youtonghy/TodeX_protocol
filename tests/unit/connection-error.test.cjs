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
