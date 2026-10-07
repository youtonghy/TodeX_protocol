const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { jitteredBackoffMs } = require(path.join(lib, 'backoff.js'));
const { nextReconnectDelayMs } = require(path.join(lib, 'connectionProbe.js'));

test('equal jitter stays within half and all of the exponential ceiling', () => {
  const options = { baseMs: 1000, capMs: 8000 };
  assert.equal(jitteredBackoffMs(0, { ...options, random: () => 0 }), 500);
  assert.equal(jitteredBackoffMs(0, { ...options, random: () => 0.999999 }), 1000);
  assert.equal(jitteredBackoffMs(2, { ...options, random: () => 0.5 }), 3000);
  // The ceiling stops at the cap however many attempts failed.
  assert.equal(jitteredBackoffMs(50, { ...options, random: () => 0 }), 4000);
  assert.equal(jitteredBackoffMs(Number.POSITIVE_INFINITY, { ...options, random: () => 1 }), 1000);
  assert.equal(jitteredBackoffMs(-3, { ...options, random: () => 1 }), 1000);
});

test('reconnect delays spread out instead of firing in lockstep', () => {
  const samples = Array.from({ length: 64 }, (_, index) => nextReconnectDelayMs(3, () => index / 64));
  assert.ok(samples.every((delay) => delay >= 8000 && delay <= 16000));
  assert.ok(new Set(samples).size > 32);
  assert.equal(nextReconnectDelayMs(0, () => 1), 2000);
  assert.equal(nextReconnectDelayMs(20, () => 1), 30000);
  assert.equal(nextReconnectDelayMs(20, () => 0), 15000);
});
