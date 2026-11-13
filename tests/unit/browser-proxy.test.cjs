const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  BROWSER_PROXY_PATH,
  browserProxyFailure,
  browserProxyHasBody,
  browserProxyRequestBody,
  browserProxyRequestHeaders,
  browserProxyTransportRequest,
  encodeBase64,
  parseBrowserProxyResponseHead,
} = require(path.join(lib, 'browserProxy.js'));
const { encodeBase64Url } = require(path.join(lib, 'transportCrypto.js'));

const encodeHeaders = (pairs) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(pairs)));

test('request headers drop hop-by-hop, host, length and x-todex-* headers', () => {
  const kept = browserProxyRequestHeaders([
    ['Host', '127.0.0.1:5173'],
    ['Connection', 'keep-alive'],
    ['Content-Length', '3'],
    ['Transfer-Encoding', 'chunked'],
    ['Upgrade', 'websocket'],
    ['Expect', '100-continue'],
    ['Proxy-Authorization', 'x'],
    ['X-Todex-Device', 'd'],
    ['Accept', '*/*'],
    ['Cookie', 'a=b'],
    ['Origin', 'http://localhost:5173'],
    ['Accept', 'text/html'],
  ]);
  assert.deepEqual(kept, [['accept', '*/*'], ['cookie', 'a=b'], ['origin', 'http://localhost:5173'], ['accept', 'text/html']]);
  assert.deepEqual(browserProxyRequestHeaders([['Cookie', 'a=b'], ['Accept', '*/*']], { dropCookies: true }), [['accept', '*/*']]);
});

test('the request body carries the page request, with the body as padded base64', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0x01, 0x02]);
  assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(encodeBase64(new Uint8Array([1])), 'AQ==');
  const body = JSON.parse(browserProxyRequestBody({ method: 'POST', url: 'http://127.0.0.1:5173/api', headers: [['accept', '*/*']], body: bytes }));
  assert.deepEqual(body, { method: 'POST', url: 'http://127.0.0.1:5173/api', headers: [['accept', '*/*']], body: '+/8BAg==' });
  const empty = JSON.parse(browserProxyRequestBody({ method: 'GET', url: 'http://localhost:3000/', headers: [], body: new Uint8Array() }));
  assert.equal('body' in empty, false);
  const signal = new AbortController().signal;
  const request = browserProxyTransportRequest({ method: 'GET', url: 'http://localhost:3000/', headers: [] }, signal);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, BROWSER_PROXY_PATH);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.signal, signal);
});

test('the response head unwraps the status and repeated headers', () => {
  const head = parseBrowserProxyResponseHead({
    'x-todex-proxy-status': '302',
    'x-todex-proxy-headers': encodeHeaders([['Location', '/next'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['Transfer-Encoding', 'chunked'], ['Content-Type', 'text/html; charset=中']]),
  });
  assert.deepEqual(head, { status: 302, headers: [['Location', '/next'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['Content-Type', 'text/html; charset=中']] });
  assert.deepEqual(parseBrowserProxyResponseHead({ 'X-Todex-Proxy-Status': '204' }), { status: 204, headers: [] });
  assert.equal(parseBrowserProxyResponseHead({}), null);
  assert.equal(parseBrowserProxyResponseHead({ 'x-todex-proxy-status': 'abc' }), null);
  assert.equal(parseBrowserProxyResponseHead({ 'x-todex-proxy-status': '200', 'x-todex-proxy-headers': '!!' }), null);
  assert.equal(parseBrowserProxyResponseHead({ 'x-todex-proxy-status': '200', 'x-todex-proxy-headers': encodeHeaders([['a']]) }), null);
});

test('bodies follow the method and status', () => {
  assert.equal(browserProxyHasBody('GET', 200), true);
  assert.equal(browserProxyHasBody('head', 200), false);
  for (const status of [101, 103, 204, 205, 304]) assert.equal(browserProxyHasBody('GET', status), false, String(status));
});

test('failures map to the desktop error pages', () => {
  assert.deepEqual(browserProxyFailure(404, '', '127.0.0.1:5173'), { kind: 'backend-outdated' });
  assert.deepEqual(
    browserProxyFailure(502, JSON.stringify({ code: 'BROWSER_TARGET_UNREACHABLE', message: 'connect refused 127.0.0.1:5173' }), '127.0.0.1:5173'),
    { kind: 'target-unreachable', target: '127.0.0.1:5173' },
  );
  assert.deepEqual(
    browserProxyFailure(503, JSON.stringify({ code: 'TRANSPORT_BUSY', message: 'too many requests' }), 'localhost:3000'),
    { kind: 'forward-failed', target: 'localhost:3000', reason: 'too many requests' },
  );
  assert.deepEqual(browserProxyFailure(500, 'x'.repeat(300), 'localhost:3000'), { kind: 'forward-failed', target: 'localhost:3000', reason: 'x'.repeat(200) });
  assert.deepEqual(browserProxyFailure(500, '', 'localhost:3000'), { kind: 'forward-failed', target: 'localhost:3000', reason: 'HTTP 500' });
});
