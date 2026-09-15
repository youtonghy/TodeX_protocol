const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const parity = require(path.join(compiledDir, 'lib', 'mobileParity.js'));
const { TimelineStore } = require(path.join(compiledDir, 'lib', 'timelineStore.js'));
const todex = require(path.join(compiledDir, 'lib', 'todex.js'));
const v2 = require(path.join(compiledDir, 'lib', 'v2.js'));

function event(overrides = {}) {
  return {
    schemaVersion: 2,
    eventId: 'evt-1',
    conversationId: 'conversation-1',
    sequence: 1,
    time: '2026-01-01T00:00:00.000Z',
    type: 'message.delta',
    payload: {},
    ...overrides,
  };
}

test('normalizes backend profiles and legacy field aliases', () => {
  const profile = parity.normalizeBackendConnectionProfile({
    id: ' profile-1 ',
    display_name: 'Team backend',
    server_url: 'ws://localhost:7345/',
    auth_token: 'secret',
    tenant_id: 'team',
    encryption_protocol: 'ML-KEM-768',
    encryption_public_key: 'pk',
    created_at: '1700000000000',
    updated_at: 1700000000100,
  }, { now: 42 });

  assert.deepEqual(profile, {
    id: 'profile-1',
    name: 'Team backend',
    serverUrl: 'http://127.0.0.1:7345',
    authToken: 'secret',
    deviceSecret: '',
    tenantId: 'team',
    encryptionProtocol: 'ml-kem-768',
    encryptionPublicKey: 'pk',
    createdAt: 1700000000000,
    updatedAt: 1700000000100,
  });
  assert.equal(parity.normalizeBackendConnectionProfile({ id: 'missing-url' }, { now: 42 }), null);
  assert.equal(
    parity.normalizeBackendConnectionProfile({ id: 'ipv6', serverUrl: 'http://[::1]:7345' }, { now: 42 }).serverUrl,
    'http://127.0.0.1:7345',
  );
  assert.equal(parity.normalizeBackendConnectionProfiles({ profiles: [profile, profile] }).length, 1);
  assert.equal(todex.normalizeBackendConnectionProfile({ id: 'barrel', serverUrl: 'localhost:7345' }, { now: 42 }).id, 'barrel');
});

test('normalizes conversation records and manifests into the shared shape', () => {
  const record = parity.normalizeConversationRecord({
    id: 'c1',
    workspace_id: 'workspace-1',
    provider: 'pi',
    reasoning_effort: 'extra-high',
    status: 'running',
    last_sequence: '7',
    updated_at: '2026-01-02T00:00:00Z',
  }, { now: 100 });

  assert.equal(record.id, 'c1');
  assert.equal(record.workspaceId, 'workspace-1');
  assert.equal(record.title, 'Pi');
  assert.equal(record.reasoningEffort, 'xhigh');
  assert.equal(record.v2ConversationId, 'c1');
  assert.equal(record.lastSequence, 7);
  assert.equal(record.sessionId, 'v2_c1');
  assert.equal(record.updatedAt, Date.parse('2026-01-02T00:00:00Z'));

  const manifest = parity.conversationFromManifest({
    schemaVersion: 2,
    id: 'm1',
    provider: 'claude-code',
    ownerId: 'owner',
    workspace: '/workspace/project',
    status: 'idle',
    lastSequence: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
  }, 'workspace-1');
  assert.equal(manifest.title, 'Claude Code');
  assert.equal(manifest.v2ConversationId, 'm1');
  assert.equal(manifest.sessionId, 'v2_m1');
  assert.equal(manifest.workspaceId, 'workspace-1');
});

test('extracts token usage from protocol and provider completion events', () => {
  const normalizedEvent = event({
    type: 'usage.updated',
    payload: {
      provider: 'codex',
      contextWindow: 200000,
      usage: {
        cumulative: { total: 300, input: 180, output: 80, cacheRead: 40, cacheWrite: 0 },
        last: { total: 90, input: 50, output: 30, cacheRead: 10, cacheWrite: 0 },
      },
    },
  });
  assert.deepEqual(parity.contextUsageFromV2Event(normalizedEvent, 42), {
    usedTokens: 90,
    contextWindow: 200000,
    inputTokens: 50,
    outputTokens: 30,
    cachedInputTokens: 10,
    cacheWriteTokens: 0,
    updatedAt: Date.parse(normalizedEvent.time),
  });

  const tokenEvent = event({
    type: 'provider.event',
    payload: {
      providerMethod: 'thread/tokenUsage/updated',
      metadata: {
        tokenUsage: {
          modelContextWindow: 128000,
          last: {
            totalTokens: 120,
            inputTokens: 80,
            outputTokens: 30,
            cachedInputTokens: 5,
            cacheWriteInputTokens: 5,
          },
        },
      },
    },
  });
  assert.deepEqual(parity.contextUsageFromV2Event(tokenEvent, 42), {
    usedTokens: 120,
    contextWindow: 128000,
    inputTokens: 80,
    outputTokens: 30,
    cachedInputTokens: 5,
    cacheWriteTokens: 5,
    updatedAt: Date.parse(tokenEvent.time),
  });

  const completion = event({
    eventId: 'evt-2',
    type: 'message.completed',
    payload: {
      provider: 'pi',
      message: {
        role: 'assistant',
        model: 'pi-model',
        usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 1 },
      },
    },
  });
  const usage = parity.usageRecordFromV2Event(completion);
  assert.deepEqual(usage, {
    id: 'conversation-1:evt-2',
    conversationId: 'conversation-1',
    provider: 'pi',
    model: 'pi-model',
    inputTokens: 10,
    outputTokens: 20,
    cachedInputTokens: 3,
    cacheWriteTokens: 1,
    updatedAt: Date.parse(completion.time),
  });

  const normalized = parity.normalizeUsageRecords({ records: [usage, usage, { id: 'other', conversation_id: 'c2' }] }, { now: 99 });
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1].updatedAt, 99);
});

test('classifies nested Pi thought, tool, and assistant events', () => {
  const thought = parity.classifyV2ConversationEvent(event({
    type: 'thought.delta',
    payload: { delta: { type: 'thinking_delta', thinking: 'checking the workspace' } },
  }), 'workspace-1', 'turn-1', 42);
  assert.equal(thought.kind, 'system');
  assert.equal(thought.title, '思考中');
  assert.equal(thought.subtitle, 'checking the workspace');
  assert.equal(thought.at, Date.parse('2026-01-01T00:00:00.000Z'));

  const nextThought = parity.classifyV2ConversationEvent(event({
    eventId: 'thought-2',
    type: 'thought.delta',
    payload: { delta: { type: 'thinking_delta', contentIndex: 0, delta: ' next' } },
  }), 'workspace-1');
  const firstThought = parity.classifyV2ConversationEvent(event({
    eventId: 'thought-1',
    type: 'thought.delta',
    payload: { delta: { type: 'thinking_delta', contentIndex: 0, delta: 'first' } },
  }), 'workspace-1');
  assert.equal(nextThought.id, firstThought.id);

  const tool = parity.classifyV2ConversationEvent(event({
    eventId: 'tool-1',
    type: 'tool.updated',
    payload: {
      provider: 'pi',
      delta: { type: 'toolcall_delta', content: [{ text: 'partial args' }] },
    },
  }), 'workspace-1', 'turn-1');
  assert.equal(tool.kind, 'system');
  assert.equal(tool.title, '工具调用');
  assert.equal(tool.subtitle, 'partial args');

  const nextTool = parity.classifyV2ConversationEvent(event({
    eventId: 'tool-2',
    type: 'tool.updated',
    payload: { delta: { type: 'toolcall_end', contentIndex: 2, content: 'done' } },
  }), 'workspace-1');
  const firstTool = parity.classifyV2ConversationEvent(event({
    eventId: 'tool-1',
    type: 'tool.updated',
    payload: { delta: { type: 'toolcall_delta', contentIndex: 2, content: 'partial' } },
  }), 'workspace-1');
  assert.equal(nextTool.id, firstTool.id);

  const rawProviderTool = parity.classifyV2ConversationEvent(event({
    type: 'provider.event',
    payload: { providerMethod: 'tool_execution_start', metadata: { toolName: 'bash' } },
  }), 'workspace-1', 'turn-1');
  assert.equal(rawProviderTool.title, '工具调用');

  const assistant = parity.classifyV2ConversationEvent(event({
    type: 'message.delta',
    payload: {
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { content: 'world' }] },
    },
  }), 'workspace-1', 'turn-1');
  assert.equal(assistant.kind, 'incoming');
  assert.equal(assistant.subtitle, 'hello world');
  assert.equal(assistant.raw, '');

  const user = parity.classifyV2ConversationEvent(event({
    type: 'message.created',
    payload: { message: { role: 'user', content: [{ text: 'prompt' }] } },
  }), 'workspace-1');
  assert.equal(user.kind, 'outgoing');
  assert.equal(user.subtitle, 'prompt');
});

test('uses normalized block semantics before misleading payload fields', () => {
  const normalized = (category, id, phase, extra = {}) => event({
    type: category === 'tool' ? 'tool.updated' : 'message.completed',
    payload: {
      block: { category, id, turnId: 'turn-1', phase },
      ...extra,
    },
  });

  const firstTool = parity.classifyV2ConversationEvent(normalized('tool', 'tool-1', 'started', {
    arguments: { command: 'pwd' },
    thinking: 'must not become reasoning',
  }), 'workspace-1');
  const secondTool = parity.classifyV2ConversationEvent(normalized('tool', 'tool-2', 'completed', {
    result: { ok: true },
  }), 'workspace-1');
  assert.equal(firstTool.category, 'tool');
  assert.equal(firstTool.title, '工具调用');
  assert.notEqual(firstTool.id, secondTool.id);
  assert.equal(parity.shouldAppendV2ConversationEvent(normalized('tool', 'tool-1', 'started')), false);
  assert.equal(parity.shouldAppendV2ConversationEvent(normalized('tool', 'tool-1', 'delta')), true);
  assert.equal(parity.shouldAppendV2ConversationEvent(normalized('tool', 'tool-1', 'completed')), false);

  const final = parity.classifyV2ConversationEvent(normalized('assistant_final', 'answer-1', 'completed', {
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'final answer' },
        { type: 'toolCall', name: 'read' },
      ],
    },
    tool: { name: 'misleading' },
  }), 'workspace-1');
  assert.equal(final.category, 'assistant_final');
  assert.equal(final.kind, 'incoming');
  assert.equal(final.subtitle, 'final answer');

  const progress = parity.classifyV2ConversationEvent(normalized('assistant_progress', 'progress-1', 'delta', {
    delta: { text: 'intermediate' },
  }), 'workspace-1');
  // Preserve progress semantics for runtime projection, but keep it out of final answers.
  assert.equal(progress.category, 'assistant_progress');
  assert.equal(progress.kind, 'system');
  assert.equal(progress.title, '进展');
  assert.equal(progress.subtitle, 'intermediate');
  assert.equal(parity.isStepProgressEntry(progress), true);
  assert.equal(parity.isVisibleConversationEntry(progress), false);
});

test('does not promote unknown context content into an assistant answer', () => {
  const unknown = parity.classifyV2ConversationEvent(event({
    type: 'context.updated',
    payload: { content: 'internal context, not a response' },
  }), 'workspace-1');
  assert.equal(unknown, null);
});

test('ignores legacy Pi tool-use and tool-result message completions', () => {
  const toolUse = parity.classifyV2ConversationEvent(event({
    type: 'message.completed',
    payload: { message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'draft' }] } },
  }), 'workspace-1');
  const toolResult = parity.classifyV2ConversationEvent(event({
    type: 'message.completed',
    payload: { message: { role: 'toolResult', content: [{ type: 'text', text: 'internal output' }] } },
  }), 'workspace-1');
  assert.equal(toolUse, null);
  assert.equal(toolResult, null);
  assert.equal(parity.isVisibleConversationEntry({
    id: 'legacy-pi-tool-result',
    kind: 'incoming',
    title: 'Agent',
    subtitle: 'internal output',
    raw: JSON.stringify({ payload: { provider: 'pi', message: { role: 'toolResult', content: 'internal output' } } }),
    at: 1,
  }), false);
});

test('usage fallback does not double count cached input tokens', () => {
  const usage = parity.contextUsageFromV2Event(event({
    type: 'provider.event',
    payload: {
      block: { category: 'usage', id: 'usage-1', turnId: 'turn-1', phase: 'completed' },
      usage: { last: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5 } },
      model: 'model-1',
    },
  }));
  assert.equal(usage.usedTokens, 120);
  assert.equal(usage.model, 'model-1');
});

test('appends normalized Grok Build streams and hides provider lifecycle noise', () => {
  const firstChunk = event({
    type: 'message.delta',
    payload: { provider: 'grok-build', role: 'assistant', content: { type: 'text', text: '预览' } },
  });
  const finalChunk = event({
    type: 'message.delta',
    payload: { provider: 'grok-build', role: 'assistant', content: { type: 'text', text: '完成。' } },
  });
  assert.equal(parity.shouldAppendV2ConversationEvent(firstChunk), true);
  assert.equal(parity.shouldAppendV2ConversationEvent(finalChunk), true);
  assert.equal(parity.classifyV2ConversationEvent(firstChunk, 'workspace-1', 'turn-1').subtitle, '预览');
  const store = new TimelineStore(10);
  store.upsertBatch([firstChunk, finalChunk].map((chunk) => ({
    entry: parity.classifyV2ConversationEvent(chunk, 'workspace-1', 'turn-1'),
    appendSubtitle: parity.shouldAppendV2ConversationEvent(chunk),
  })));
  assert.equal(store.getConversationSnapshot('workspace-1', 'conversation-1')[0].subtitle, '预览完成。');

  for (const providerMethod of ['_x.ai/mcp/server_status', '_x.ai/mcp_initialized']) {
    const lifecycle = parity.classifyV2ConversationEvent(event({
      type: 'provider.event',
      payload: { provider: 'grok-build', providerMethod, metadata: { sessionId: 'session-1' } },
    }), 'workspace-1', 'turn-1');
    assert.equal(lifecycle, null);
  }

  const tool = parity.classifyV2ConversationEvent(event({
    type: 'provider.event',
    payload: { provider: 'grok-build', providerMethod: '_x.ai/mcp/tool_call', metadata: { name: 'build' } },
  }), 'workspace-1', 'turn-1');
  assert.equal(tool.title, '工具调用');
});

test('filters startup reminders and groups progress entries', () => {
  const reminder = {
    id: 'r', kind: 'system', title: '启动', subtitle: '本地会话启动超时', raw: '{}', at: 1,
  };
  assert.equal(parity.isChatReminderEntry(reminder), true);
  assert.equal(parity.isVisibleConversationEntry(reminder), false);
  assert.equal(parity.isVisibleConversationEntry({ ...reminder, subtitle: 'codex.local.turn' }), false);
  assert.equal(parity.isVisibleConversationEntry({ ...reminder, subtitle: '普通消息' }), true);

  const steps = [
    { id: 'thought', kind: 'system', title: '思考中', subtitle: 'hmm', raw: '{}', at: 1 },
    { id: 'tool', kind: 'system', title: '工具调用', subtitle: '{}', raw: '{}', at: 2 },
    { id: 'message', kind: 'incoming', title: 'Agent', subtitle: 'done', raw: '{}', at: 3 },
  ];
  assert.equal(parity.isStepProgressEntry(steps[0]), true);
  assert.equal(parity.isStepProgressEntry(steps[1]), true);
  const items = parity.buildConversationRenderItems(steps);
  assert.equal(items[0].type, 'executionGroup');
  assert.equal(items[0].entries.length, 2);
  assert.equal(items[1].type, 'entry');
});

test('keeps process group ids stable and separates adjacent turns', () => {
  const step = (id, turnId, at) => ({
    id,
    kind: 'system',
    title: '工具调用',
    subtitle: id,
    raw: '',
    at,
    conversationId: 'conversation-1',
    category: 'tool',
    phase: 'completed',
    turnId,
  });
  const first = parity.buildConversationRenderItems([step('a', 'turn-1', 1)]);
  const extended = parity.buildConversationRenderItems([step('a', 'turn-1', 1), step('b', 'turn-1', 2)]);
  assert.equal(first[0].id, extended[0].id);

  const split = parity.buildConversationRenderItems([
    step('a', 'turn-1', 1),
    step('b', 'turn-2', 2),
  ]);
  assert.equal(split.length, 2);
  assert.notEqual(split[0].id, split[1].id);
});

test('routes workspace links and validates loopback browser targets', () => {
  assert.deepEqual(
    parity.workspaceLinkTarget('docs/index.html?raw=1', '/workspace/project'),
    { kind: 'browser-file', filePath: '/workspace/project/docs/index.html' },
  );
  assert.deepEqual(
    parity.workspaceLinkTarget('notes/readme.md', '/workspace/project'),
    { kind: 'file', filePath: '/workspace/project/notes/readme.md' },
  );
  assert.equal(parity.workspaceLinkTarget('../outside.txt', '/workspace/project'), null);
  assert.equal(parity.workspaceLinkTarget('//example.com/path', '/workspace/project'), null);
  assert.deepEqual(
    parity.workspaceLinkTarget('http://localhost:7345/health', '/workspace/project', { requireLoopback: true }),
    { kind: 'browser-url', url: 'http://localhost:7345/health' },
  );
  assert.equal(parity.workspaceLinkTarget('https://example.com', '/workspace/project', { requireLoopback: true }), null);
  assert.equal(parity.isLoopbackUrl('http://127.0.0.42:7345'), true);
  assert.equal(parity.isLoopbackUrl('http://localhost.evil.test'), false);
  assert.deepEqual(parity.validateLoopbackUrl('http://[::1]:7345/path'), { ok: true, url: 'http://[::1]:7345/path' });
  assert.equal(parity.validateLoopbackUrl('file:///tmp/test').ok, false);
});

test('returns stable provider icon metadata for known and unknown agents', () => {
  assert.equal(parity.providerIconMetadata('claude-code').id, 'claude-code');
  assert.deepEqual(
    parity.providerIconMetadata('grok'),
    parity.PROVIDER_ICON_METADATA['grok-build'],
  );
  assert.equal(parity.providerIconMetadata('my-codex-wrapper').label, 'Codex CLI');
  const unknown = parity.providerIconMetadata('custom-agent');
  assert.equal(unknown.id, 'custom-agent');
  assert.equal(unknown.icon, 'cube-outline');
  assert.equal(parity.providerIconMetadata(null).accessibilityLabel, 'Agent');
});

test('includes reasoning effort in v2 HTTP prompt payloads', async () => {
  const requests = [];
  const client = new v2.V2ApiClient({
    serverUrl: 'http://127.0.0.1:7345',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ conversationId: 'c1', turnId: 't1' }), { status: 200 });
    },
  });
  await client.prompt('c1', 'hello', 'gpt-5.5', undefined, ' high ');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: 'hello', model: 'gpt-5.5', reasoningEffort: 'high',
  });
});
