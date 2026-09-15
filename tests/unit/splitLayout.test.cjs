const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const {
  calculateSplitLeftWidth,
  clampSplitLeftWidth,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_MIN_LEFT_WIDTH,
  DEFAULT_MIN_RIGHT_WIDTH,
} = require(path.join(compiledDir, 'lib', 'splitLayout.js'));

test('calculateSplitLeftWidth uses default 52% ratio for 1180px iPad landscape', () => {
  const total = 1180;
  const left = calculateSplitLeftWidth(total);
  assert.equal(left, Math.round(total * DEFAULT_SPLIT_RATIO));
  assert.equal(left > DEFAULT_MIN_LEFT_WIDTH, true);
  assert.equal(total - left > DEFAULT_MIN_RIGHT_WIDTH, true);
});

test('clampSplitLeftWidth enforces minimum left width constraint', () => {
  const total = 1000;
  // Dragging too far to the left (e.g. 200px)
  const clamped = clampSplitLeftWidth(200, total, 360, 320);
  assert.equal(clamped, 360);
});

test('clampSplitLeftWidth enforces minimum right width constraint', () => {
  const total = 1000;
  // Dragging too far to the right (e.g. 850px, leaving only 150px for right)
  const clamped = clampSplitLeftWidth(850, total, 360, 320);
  // Max left is total - minRight = 1000 - 320 = 680
  assert.equal(clamped, 680);
});

test('calculateSplitLeftWidth handles narrow screens safely', () => {
  const total = 500;
  const left = calculateSplitLeftWidth(total, 0.5, 360, 320);
  // Total 500 cannot satisfy 360+320=680, effective minLeft is total/2 = 250
  assert.equal(left, 250);
});

test('split only activates when both columns and the divider fit', () => {
  const { canSplitWidth, MIN_SPLIT_WIDTH, SPLIT_DIVIDER_WIDTH } = require(path.join(compiledDir, 'lib', 'splitLayout.js'));
  assert.equal(MIN_SPLIT_WIDTH, 740);
  assert.equal(canSplitWidth(739), false);
  assert.equal(canSplitWidth(740), true);
  assert.equal(canSplitWidth(768), true);
  const available = 740 - SPLIT_DIVIDER_WIDTH;
  assert.equal(calculateSplitLeftWidth(available), 360);
  assert.equal(available - clampSplitLeftWidth(999, available), 360);
});

test('chat bubble widths follow the column, not iPad orientation', () => {
  const { messageBubbleMaxWidth } = require(path.join(compiledDir, 'lib', 'responsive.js'));
  assert.equal(messageBubbleMaxWidth(360, false), 336);
  assert.equal(messageBubbleMaxWidth(360, true) < 336, true);
  assert.equal(messageBubbleMaxWidth(1200, false), 800);
  assert.equal(messageBubbleMaxWidth(1200, true), 640);
});

test('render layout reclamps old drag position on resize before layout state catches up', () => {
  const { resolveSplitLayout } = require(path.join(compiledDir, 'lib', 'splitLayout.js'));
  assert.deepEqual(resolveSplitLayout(740, 900, true), { split: true, leftWidth: 360, rightWidth: 360, dividerWidth: 20 });
  assert.deepEqual(resolveSplitLayout(739, 500, true), { split: false, leftWidth: 739, rightWidth: 0, dividerWidth: 0 });
  assert.deepEqual(resolveSplitLayout(1180, 600, false), { split: false, leftWidth: 1180, rightWidth: 0, dividerWidth: 0 });
});

test('layout invariants hold across phone and iPad widths and extreme drag positions', () => {
  const { resolveSplitLayout } = require(path.join(compiledDir, 'lib', 'splitLayout.js'));
  for (const width of [0, 320, 390, 600, 739, 740, 740.9, 768, 820, 1024, 1180, 1366]) {
    for (const requested of [-100, 0, 350, 600, 10000, NaN]) {
      const layout = resolveSplitLayout(width, requested, true);
      assert.ok(Math.abs(layout.leftWidth + layout.rightWidth + layout.dividerWidth - width) < 0.001);
      if (layout.split) {
        assert.ok(layout.leftWidth >= 360);
        assert.ok(layout.rightWidth >= 360);
      } else assert.equal(layout.rightWidth, 0);
    }
  }
  assert.deepEqual(resolveSplitLayout(NaN, 600, true), { split: false, leftWidth: 0, rightWidth: 0, dividerWidth: 0 });
});
