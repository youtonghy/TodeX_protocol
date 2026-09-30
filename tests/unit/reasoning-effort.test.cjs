const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const todex = require(path.join(compiledDir, 'lib', 'todex.js'));
const parity = require(path.join(compiledDir, 'lib', 'mobileParity.js'));

test('normalizeReasoningEffort keeps top tiers distinct and accepts ultra spellings', () => {
  assert.equal(todex.normalizeReasoningEffort('ultra'), 'ultra');
  assert.equal(todex.normalizeReasoningEffort(' Ultra '), 'ultra');
  assert.equal(todex.normalizeReasoningEffort('highest'), 'ultra');
  assert.equal(todex.normalizeReasoningEffort('ultracode'), 'ultracode');
  assert.equal(todex.normalizeReasoningEffort('max'), 'max');
  assert.equal(todex.normalizeReasoningEffort('xhigh'), 'xhigh');
  assert.equal(todex.normalizeReasoningEffort('extra-high'), 'xhigh');
  assert.equal(todex.normalizeReasoningEffort('bogus'), null);
});

test('mobile parity normalizer accepts the same ladder', () => {
  assert.equal(parity.normalizeConversationReasoningEffort('ultra'), 'ultra');
  assert.equal(parity.normalizeConversationReasoningEffort('ultracode'), 'ultracode');
  assert.equal(parity.normalizeConversationReasoningEffort('max'), 'max');
  assert.equal(parity.normalizeConversationReasoningEffort('extra_high'), 'xhigh');
});

test('provider-advertised ultra and max survive catalog parsing', () => {
  const catalog = todex.parseCodexModelListResponse({
    data: [{
      model: 'gpt-5.6-sol',
      displayName: 'gpt-5.6-sol',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' },
        { reasoningEffort: 'max' },
        { reasoningEffort: 'ultra' },
      ],
      defaultReasoningEffort: 'medium',
    }],
  });
  const entry = catalog.find((item) => item.model === 'gpt-5.6-sol');
  assert.deepEqual(
    entry.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('workspace records keep provider-advertised top-tier efforts', () => {
  for (const effort of ['ultra', 'ultracode', 'max']) {
    const record = todex.normalizeWorkspaceRecord({
      id: 'w1', path: '/repo', reasoningEffort: effort,
    });
    assert.equal(record.reasoningEffort, effort);
  }
});

test('default options stop at max; ultra stays catalog-gated', () => {
  const ids = todex.DEFAULT_REASONING_EFFORT_OPTIONS.map((option) => option.reasoningEffort);
  assert.deepEqual(ids, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});
