const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { retryWithDelays } = require(path.join(compiledDir, 'lib', 'retry.js'));

function flaky(failures, value = 'ok') {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls <= failures) throw new Error(`failure ${calls}`);
    return value;
  };
  return { operation, calls: () => calls };
}

test('retryWithDelays returns the first success without retrying', async () => {
  const run = flaky(0);
  assert.equal(await retryWithDelays(run.operation, { delaysMs: [1, 1] }), 'ok');
  assert.equal(run.calls(), 1);
});

test('retryWithDelays recovers from transient failures', async () => {
  const run = flaky(2);
  const givenUp = [];
  const result = await retryWithDelays(run.operation, { delaysMs: [1, 1], onGiveUp: (error) => givenUp.push(error) });
  assert.equal(result, 'ok');
  assert.equal(run.calls(), 3);
  assert.deepEqual(givenUp, []);
});

test('retryWithDelays reports the last error once retries are exhausted', async () => {
  const run = flaky(10);
  const givenUp = [];
  const result = await retryWithDelays(run.operation, { delaysMs: [1, 1], onGiveUp: (error) => givenUp.push(error) });
  assert.equal(result, null);
  assert.equal(run.calls(), 3);
  assert.equal(givenUp.length, 1);
  assert.equal(givenUp[0].message, 'failure 3');
});

test('retryWithDelays stops quietly when cancelled during a wait', async () => {
  const run = flaky(10);
  let cancelled = false;
  const givenUp = [];
  const pending = retryWithDelays(run.operation, {
    delaysMs: [50, 50],
    isCancelled: () => cancelled,
    onGiveUp: (error) => givenUp.push(error),
  });
  cancelled = true;
  assert.equal(await pending, null);
  assert.equal(run.calls(), 1);
  assert.deepEqual(givenUp, []);
});
