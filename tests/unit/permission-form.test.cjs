const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const forms = require(path.join(compiledDir, 'permissionForm.js'));

const request = (data) => ({ requestId: 'p', requestType: 'permission', title: 't', event: {}, data });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('plain approvals have no form', () => {
  assert.equal(forms.permissionForm(request({ kind: 'tool', options: [] })), null);
});

test('user_input questions answer as string arrays per question id', () => {
  const form = forms.permissionForm(request({ kind: 'user_input', details: { questions: [
    { id: 'q0', header: 'Lang', question: 'Which language?', options: [{ label: 'Rust', description: 'fast' }, { label: 'Go' }], isOther: true },
    { id: 'q1', question: 'Pick any', options: ['A', 'B', 'C'], multiSelect: true },
    { id: 'q2', question: 'Token?', isSecret: true },
  ] } }));
  assert.equal(form.mode, 'user_input');
  assert.equal(form.unsupported, false);
  assert.deepEqual(form.fields.map(field => [field.id, field.header, field.multiple, field.other, field.secret]),
    [['q0', 'Lang', false, true, false], ['q1', undefined, true, false, false], ['q2', undefined, false, false, true]]);
  assert.equal(form.fields[0].choices[0].description, 'fast');
  const answer = forms.permissionFormAnswer(form, { q0: '', q1: '0,2', q2: 'abc' }, { q0: 'Zig' });
  assert.deepEqual(plain(answer), { data: { answers: { q0: { answers: ['Zig'] }, q1: { answers: ['A', 'C'] }, q2: { answers: ['abc'] } } } });
  assert.deepEqual(forms.permissionFormAnswer(form, { q0: '1', q1: '' }), { error: { code: 'required', label: 'Pick any' } });
  assert.equal(forms.permissionFieldAnswered(form.fields[0], {}, { q0: ' x ' }), true);
  assert.deepEqual([...forms.permissionFieldPicks('2,0')], [2, 0]);
});

test('questions without ids are unsupported', () => {
  const form = forms.permissionForm(request({ kind: 'user_input', details: { questions: [{ question: 'x' }] } }));
  assert.equal(form.unsupported, true);
  assert.deepEqual(forms.permissionFormAnswer(form, {}), { error: { code: 'unsupported' } });
});

test('elicitation schemas become typed fields with validation', () => {
  const form = forms.permissionForm(request({ kind: 'elicitation', details: { requestedSchema: {
    type: 'object', required: ['name', 'count'],
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      color: { enum: ['red', 'blue'], default: 'blue' },
      ok: { type: 'boolean' },
    },
  } } }));
  assert.equal(form.unsupported, false);
  assert.equal(form.fields[2].initial, '1');
  assert.deepEqual(plain(forms.permissionFormAnswer(form, { name: 'ab', count: '3', ok: 'false' })), { data: { name: 'ab', count: 3, color: 'blue', ok: false } });
  assert.deepEqual(forms.permissionFormAnswer(form, { name: 'a', count: '3' }), { error: { code: 'length', label: 'Name' } });
  assert.deepEqual(forms.permissionFormAnswer(form, { name: 'ab', count: '2.5' }), { error: { code: 'integer', label: 'count' } });
  assert.deepEqual(forms.permissionFormAnswer(form, { name: 'ab', count: '9' }), { error: { code: 'range', label: 'count' } });
  const nested = forms.permissionForm(request({ kind: 'elicitation', details: { schema: { type: 'object', properties: { x: { type: 'object' } } } } }));
  assert.equal(nested.unsupported, true);
});

test('url elicitations open only http(s) links and answer completed', () => {
  const ok = forms.permissionForm(request({ kind: 'elicitation', details: { mode: 'url', url: 'https://example.com/verify' } }));
  assert.equal(ok.url, 'https://example.com/verify');
  assert.deepEqual(plain(forms.permissionFormAnswer(ok, {})), { data: { completed: true } });
  const bad = forms.permissionForm(request({ kind: 'elicitation', details: { mode: 'url', url: 'javascript:alert(1)' } }));
  assert.equal(bad.unsupported, true);
});

test('pi extension prompts answer confirmed or value', () => {
  const confirm = forms.permissionForm(request({ kind: 'extension_ui', details: { method: 'confirm', message: 'Go?' } }));
  assert.deepEqual(plain(forms.permissionFormAnswer(confirm, { confirmed: 'true' })), { data: { confirmed: true } });
  const select = forms.permissionForm(request({ kind: 'extension_ui', details: { method: 'select', options: ['a', 'b'] } }));
  assert.equal(select.fields[0].label, '');
  assert.deepEqual(plain(forms.permissionFormAnswer(select, { value: '1' })), { data: { value: 'b' } });
  const editor = forms.permissionForm(request({ kind: 'extension_ui', details: { method: 'editor', prefill: 'draft' } }));
  assert.deepEqual(plain(forms.permissionFormAnswer(editor, {})), { data: { value: 'draft' } });
  assert.equal(forms.permissionForm(request({ kind: 'extension_ui', details: { method: 'custom' } })).unsupported, true);
});

test('option labels, reject detection and plan feedback', () => {
  const option = (name, kind) => ({ optionId: name, name, kind });
  assert.equal(forms.permissionOptionLabel(option('Allow for session', 'allow_always')), 'allowSession');
  assert.equal(forms.permissionOptionLabel(option('Reject and stop turn', 'abort_turn')), 'rejectStop');
  assert.equal(forms.permissionOptionLabel(option('Request changes', 'reject_once')), null);
  assert.equal(forms.permissionOptionLabel(false), 'reject');
  assert.equal(forms.isRejectPermissionOption(option('x', 'abort_turn')), true);
  assert.equal(forms.isAllowPermissionOption(option('x', 'allow_always')), true);
  assert.equal(forms.permissionAcceptsFeedback(request({ kind: 'plan' }), option('Request changes', 'reject_once')), true);
  assert.equal(forms.permissionAcceptsFeedback(request({ kind: 'tool' }), option('Reject', 'reject_once')), false);
  assert.equal(forms.isQuestionPermission(request({ kind: 'question' })), true);
  assert.equal(forms.isQuestionPermission(request({ kind: 'command' })), false);
});
