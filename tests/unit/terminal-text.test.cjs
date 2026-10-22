const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizePaste, pasteNeedsConfirmation, parseOsc7, parseOsc133,
  parseTerminalNotification, findFileLinks, resolveTerminalPath,
} = require('../../dist/unit/lib/terminalText.js');

test('paste keeps text and line breaks but not control characters', () => {
  assert.equal(sanitizePaste('ls -la\n\techo ok\r\n'), 'ls -la\n\techo ok\r\n');
  assert.equal(sanitizePaste('safe\x1b[201~rm -rf /\x03\x15\x7f'), 'safe [201~rm -rf /   ');
  assert.equal(pasteNeedsConfirmation('one line', false), false);
  assert.equal(pasteNeedsConfirmation('a\nb', false), true);
  assert.equal(pasteNeedsConfirmation('a\nb', true), false);
});

test('OSC 7 accepts file and kitty-shell-cwd URLs', () => {
  assert.equal(parseOsc7('file://host/home/me/My%20Repo'), '/home/me/My Repo');
  assert.equal(parseOsc7('kitty-shell-cwd://host/home/me/My Repo'), '/home/me/My Repo');
  assert.equal(parseOsc7('file:///tmp'), '/tmp');
  assert.equal(parseOsc7('http://host/x'), null);
  assert.equal(parseOsc7('file://host/%E0%A4%A'), null);
});

test('OSC 133 marks, with options and exit status', () => {
  assert.deepEqual(parseOsc133('A;click_events=1'), { kind: 'prompt' });
  assert.deepEqual(parseOsc133('B'), { kind: 'input' });
  assert.deepEqual(parseOsc133('C'), { kind: 'command' });
  assert.deepEqual(parseOsc133('D;130'), { kind: 'finished', exitCode: 130 });
  assert.deepEqual(parseOsc133('D'), { kind: 'finished', exitCode: null });
  assert.equal(parseOsc133('Z'), null);
});

test('notifications from OSC 9 and OSC 777, not progress reports', () => {
  assert.deepEqual(parseTerminalNotification(9, 'Build done'), { title: '', body: 'Build done' });
  assert.equal(parseTerminalNotification(9, '4;1;50'), null);
  assert.deepEqual(parseTerminalNotification(777, 'notify;Claude;Waiting\x07 for you'), { title: 'Claude', body: 'Waiting for you' });
  assert.equal(parseTerminalNotification(777, 'other;x'), null);
  assert.equal(parseTerminalNotification(9, 'x'.repeat(500)).body.length, 200);
});

test('file links need a slash or a line number', () => {
  const links = findFileLinks('error in src/app.ts:12:5 and ./a/b.rs, see main.c:10, v1.2.3, https://x.io/a.js and README.md');
  assert.deepEqual(links.map((link) => [link.path, link.line, link.column]), [
    ['src/app.ts', 12, 5],
    ['./a/b.rs', undefined, undefined],
    ['main.c', 10, undefined],
  ]);
  const [link] = findFileLinks('  /abs/file.go:3');
  assert.equal(link.start, 2);
  assert.equal(link.end, 16);
});

test('linked paths resolve inside the workspace only', () => {
  assert.equal(resolveTerminalPath('src/a.ts', '/repo/pkg', '/repo'), '/repo/pkg/src/a.ts');
  assert.equal(resolveTerminalPath('../x.ts', '/repo/pkg', '/repo/'), '/repo/x.ts');
  assert.equal(resolveTerminalPath('../../etc/passwd', '/repo/pkg', '/repo'), null);
  assert.equal(resolveTerminalPath('/repository/a.ts', '/', '/repo'), null);
  assert.equal(resolveTerminalPath('~/repo/a.ts', '/', '/home/me/repo', '/home/me'), '/home/me/repo/a.ts');
  assert.equal(resolveTerminalPath('a.ts', '', '/repo'), null);
});
