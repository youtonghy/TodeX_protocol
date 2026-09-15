const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const { parseMarkdownBlocks } = require(path.join(compiledDir, 'lib', 'markdown.js'));

test('parseMarkdownBlocks parses headers correctly', () => {
  const md = '# Header 1\n\n## Header 2\n\n### Header 3';
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: 'h1', text: 'Header 1' });
  assert.deepEqual(blocks[1], { type: 'h2', text: 'Header 2' });
  assert.deepEqual(blocks[2], { type: 'h3', text: 'Header 3' });
});

test('parseMarkdownBlocks parses bullet points and paragraphs', () => {
  const md = 'Intro paragraph\n- First point\n* Second point\n• Third point';
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: 'paragraph', text: 'Intro paragraph' });
  assert.deepEqual(blocks[1], { type: 'bullet', text: 'First point' });
  assert.deepEqual(blocks[2], { type: 'bullet', text: 'Second point' });
  assert.deepEqual(blocks[3], { type: 'bullet', text: 'Third point' });
});

test('parseMarkdownBlocks parses codeblocks with language', () => {
  const md = '```ts\nconst x = 1;\nconsole.log(x);\n```';
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: 'codeblock',
    code: 'const x = 1;\nconsole.log(x);',
    language: 'ts',
  });
});

test('parseMarkdownBlocks parses desktop auto-keyboard sample markdown', () => {
  const sample = `# auto-keyboard

macOS 菜单栏应用：按窗口记忆中英文输入状态，并支持按应用规则与智能上下文自动切换输入法。

## 功能

- 窗口记忆: 记录每个窗口最后使用的输入源
- 上下文关键词: 支持 \`claude / codex\` 等场景
`;
  const blocks = parseMarkdownBlocks(sample);
  assert.equal(blocks[0].type, 'h1');
  assert.equal(blocks[0].text, 'auto-keyboard');
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[2].type, 'h2');
  assert.equal(blocks[2].text, '功能');
  assert.equal(blocks[3].type, 'bullet');
  assert.equal(blocks[4].type, 'bullet');
});

test('streamed unclosed fences preserve multiline code until closing arrives', () => {
  for (const fence of ['```', '~~~~']) {
    const partial = `${fence}ts\nconst value = 1;\n  value++`;
    assert.deepEqual(parseMarkdownBlocks(partial), [{ type: 'codeblock', language: 'ts', code: 'const value = 1;\n  value++' }]);
    assert.deepEqual(parseMarkdownBlocks(`${partial}\n${fence}\nDone`)[1], { type: 'paragraph', text: 'Done' });
  }
});

test('table parser preserves escaped pipes and inline-code pipes', () => {
  const table = parseMarkdownBlocks('| Label | Value |\n| --- | :---: |\n| a\\|b | `x|y` |\n| c | d |')[0];
  assert.deepEqual(table, { type: 'table', header: ['Label', 'Value'], rows: [['a|b', '`x|y`'], ['c', 'd']] });
});

test('code fences retain shorter fences inside them', () => {
  assert.equal(parseMarkdownBlocks('````md\n```js\nx\n```\n````')[0].code, '```js\nx\n```');
});

test('ordered lists and quotations are distinct from paragraphs', () => {
  assert.deepEqual(parseMarkdownBlocks('First\nsecond\n\n2. Step\n> quote'), [
    { type: 'paragraph', text: 'First\nsecond' }, { type: 'ordered', ordinal: '2', text: 'Step' }, { type: 'quote', text: 'quote' },
  ]);
});

test('inline links retain file targets and formatting survives streaming boundaries', () => {
  const { parseMarkdownInline } = require(path.join(compiledDir, 'lib', 'markdown.js'));
  assert.deepEqual(parseMarkdownInline('[File](</tmp/my file.ts>)'), [{ type: 'link', text: 'File', href: '/tmp/my file.ts' }]);
  assert.deepEqual(parseMarkdownInline('**waiting'), [{ type: 'text', text: '**waiting' }]);
  assert.deepEqual(parseMarkdownInline('**waiting**'), [{ type: 'bold', text: 'waiting' }]);
  assert.deepEqual(parseMarkdownInline('`[text](file)`'), [{ type: 'code', text: '[text](file)' }]);
  assert.deepEqual(parseMarkdownInline('https://example.com.'), [{ type: 'link', text: 'https://example.com', href: 'https://example.com' }, { type: 'text', text: '.' }]);
});
