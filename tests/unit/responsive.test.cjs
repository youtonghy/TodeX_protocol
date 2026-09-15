const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { computeResponsiveMetrics } = require(path.join(compiledDir, 'lib', 'responsive.js'));

test('responsive metrics correctly classifies portrait phone', () => {
  const metrics = computeResponsiveMetrics(390, 844);
  assert.equal(metrics.isLandscape, false);
  assert.equal(metrics.isPortrait, true);
  assert.equal(metrics.isTablet, false);
  assert.equal(metrics.isWide, false);
  assert.equal(metrics.isLarge, false);
  assert.equal(metrics.isLandscapeOrWide, false);
});

test('responsive metrics correctly classifies landscape phone', () => {
  const metrics = computeResponsiveMetrics(844, 390);
  assert.equal(metrics.isLandscape, true);
  assert.equal(metrics.isPortrait, false);
  assert.equal(metrics.isTablet, false);
  assert.equal(metrics.isWide, true);
  assert.equal(metrics.isLarge, false);
  assert.equal(metrics.isLandscapeOrWide, true);
});

test('responsive metrics correctly classifies iPad portrait', () => {
  const metrics = computeResponsiveMetrics(820, 1180);
  assert.equal(metrics.isLandscape, false);
  assert.equal(metrics.isPortrait, true);
  assert.equal(metrics.isTablet, true);
  assert.equal(metrics.isWide, true);
  assert.equal(metrics.isLarge, false);
  assert.equal(metrics.isLandscapeOrWide, true);
});

test('responsive metrics correctly classifies iPad landscape', () => {
  const metrics = computeResponsiveMetrics(1180, 820);
  assert.equal(metrics.isLandscape, true);
  assert.equal(metrics.isPortrait, false);
  assert.equal(metrics.isTablet, true);
  assert.equal(metrics.isWide, true);
  assert.equal(metrics.isLarge, true);
  assert.equal(metrics.isLandscapeOrWide, true);
});

test('responsive metrics correctly classifies large desktop/pro landscape', () => {
  const metrics = computeResponsiveMetrics(1366, 1024);
  assert.equal(metrics.isLandscape, true);
  assert.equal(metrics.isPortrait, false);
  assert.equal(metrics.isTablet, true);
  assert.equal(metrics.isWide, true);
  assert.equal(metrics.isLarge, true);
  assert.equal(metrics.isLandscapeOrWide, true);
});
