const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pastedTextDisposition, textLength, isPromptUploadUnsupported, uploadedPromptContent,
  PASTED_TEXT_CAPSULE_MAX_CHARS, PROMPT_IMAGE_BUDGET_BYTES,
} = require('../../dist/unit/lib/promptUploads.js');
const { promptContentFromAttachments } = require('../../dist/unit/lib/conversationCommands.js');
const { V2ApiClient } = require('../../dist/unit/lib/v2.js');
const { ConnectionError } = require('../../dist/unit/lib/connectionError.js');

test('pasted text stays inline, becomes a capsule, or becomes a file by length', () => {
  assert.equal(pastedTextDisposition('src/main.rs'), 'inline');
  assert.equal(pastedTextDisposition('x'.repeat(80)), 'inline');
  assert.equal(pastedTextDisposition(`${'x'.repeat(10)}\n\n`), 'inline');
  assert.equal(pastedTextDisposition('x'.repeat(81)), 'capsule');
  assert.equal(pastedTextDisposition('a\nb'), 'capsule');
  assert.equal(pastedTextDisposition('字'.repeat(PASTED_TEXT_CAPSULE_MAX_CHARS)), 'capsule');
  assert.equal(pastedTextDisposition('字'.repeat(PASTED_TEXT_CAPSULE_MAX_CHARS + 1)), 'file');
  // Characters, not UTF-16 units: 1000 emoji are still a capsule.
  assert.equal(textLength('😀'.repeat(3)), 3);
  assert.equal(pastedTextDisposition('😀'.repeat(PASTED_TEXT_CAPSULE_MAX_CHARS)), 'capsule');
});

test('only a bare 404 marks a daemon without the upload route', () => {
  assert.equal(isPromptUploadUnsupported(ConnectionError.apiRequestFailed(404)), true);
  assert.equal(isPromptUploadUnsupported(ConnectionError.apiRequestFailed(404, 'NOT_FOUND', 'upload not found')), false);
  assert.equal(isPromptUploadUnsupported(ConnectionError.apiRequestFailed(400, 'INVALID_REQUEST')), false);
  assert.equal(isPromptUploadUnsupported(new Error('offline')), false);
});

test('uploaded images within the budget go as localImage, everything else as file', () => {
  const budget = { used: 0 };
  assert.deepEqual(uploadedPromptContent({ path: '/tmp/todex/file/a/x.png', name: 'x.png', mimeType: 'image/png', sizeBytes: 5 }, budget), { type: 'localImage', path: '/tmp/todex/file/a/x.png' });
  assert.equal(budget.used, 5);
  assert.deepEqual(uploadedPromptContent({ path: '/p/big.jpg', name: 'big.jpg', mimeType: 'image/jpeg', sizeBytes: PROMPT_IMAGE_BUDGET_BYTES }, budget), { type: 'file', path: '/p/big.jpg', name: 'big.jpg' });
  assert.deepEqual(uploadedPromptContent({ path: '/p/a.svg', name: 'a.svg', mimeType: 'image/svg+xml', sizeBytes: 1 }, budget), { type: 'file', path: '/p/a.svg', name: 'a.svg' });
  assert.deepEqual(promptContentFromAttachments([
    { kind: 'file', name: 'r.pdf', mimeType: 'application/pdf', dataUrl: '', uploadedPath: '/tmp/todex/file/b/r.pdf', sizeBytes: 9 },
    { kind: 'file', name: 'a.txt', mimeType: 'text/plain', dataUrl: '', textContent: 'hi' },
  ]), [{ type: 'file', path: '/tmp/todex/file/b/r.pdf', name: 'r.pdf' }, { type: 'text', text: '[附件: a.txt]\nhi' }]);
});

test('upload chunks are raw PUTs that carry the upload id after the first', async () => {
  const calls = [];
  const client = new V2ApiClient({ serverUrl: 'http://127.0.0.1:7345', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init.method, type: init.headers['content-type'] });
    return new Response(JSON.stringify({ uploadId: 'u1', path: '/tmp/todex/file/u1/a b.md', name: 'a b.md', mimeType: 'text/markdown', sizeBytes: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const first = await client.uploadPromptChunk('a b.md', 0, new Uint8Array([1, 2, 3]));
  assert.equal(first.uploadId, 'u1');
  await client.uploadPromptChunk('a b.md', 3, new Uint8Array([4]), 'u1');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].type, 'application/octet-stream');
  assert.match(calls[0].url, /\/v2\/uploads\?name=a\+b\.md&offset=0$/);
  assert.match(calls[1].url, /\/v2\/uploads\?name=a\+b\.md&offset=3&uploadId=u1$/);
});
