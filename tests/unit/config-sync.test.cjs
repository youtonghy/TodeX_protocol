const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const sync = require(path.join(compiledDir, 'configSync.js'));
const { ConnectionError } = require(path.join(compiledDir, 'connectionError.js'));

const notFound = () => ConnectionError.apiRequestFailed(404, 'NOT_FOUND', 'not found');
const b64 = text => Buffer.from(text).toString('base64');

/** An in-memory backend answering the routes config sync uses. */
function fakeBackend(seed = {}) {
  const state = {
    providers: { codex: [], 'claude-code': [] },
    sshSettings: { serverAliveEnabled: true, serverAliveInterval: 30, serverAliveCountMax: 3 },
    outputFilter: { enabled: false, categories: {} },
    agentLocal: { enabled: false },
    cleanup: { enabled: false, maxAgeDays: null, maxTotalBytes: null },
    presets: [],
    instructions: {},
    cliSettings: {},
    mcp: {},
    skills: {},
    bundles: true,
    hosts: [],
    keys: [],
    calls: [],
    ...seed,
  };
  let nextId = 1;
  const log = (name, ...args) => state.calls.push([name, ...args]);
  const api = {
    async exportAgentProviders(agent) {
      if (!state.providers[agent]) throw notFound();
      return { format: 'todex.agent-providers', version: 1, agent, exportedAt: 0, providers: structuredClone(state.providers[agent]) };
    },
    async importAgentProviders(agent, transfer) {
      log('importAgentProviders', agent, transfer.providers.map(p => p.id));
      const list = state.providers[agent] ?? (state.providers[agent] = []);
      for (const provider of transfer.providers) {
        const at = list.findIndex(p => p.id === provider.id);
        if (at >= 0) list[at] = structuredClone(provider); else list.push(structuredClone(provider));
      }
      return {};
    },
    async getSshSettings() { return structuredClone(state.sshSettings); },
    async setSshSettings(value) { log('setSshSettings'); state.sshSettings = structuredClone(value); return value; },
    async getAgentOutputFilter() { return structuredClone(state.outputFilter); },
    async setAgentOutputFilter(value) { state.outputFilter = structuredClone(value); return value; },
    async getAgentLocal() { return structuredClone(state.agentLocal); },
    async setAgentLocal(value) { state.agentLocal = structuredClone(value); return value; },
    async getHistoryCleanupPolicy() { return { policy: structuredClone(state.cleanup), lastRun: null, nextRunAt: null }; },
    async updateHistoryCleanupPolicy(policy) { state.cleanup = structuredClone(policy); return {}; },
    async listInstructionPresets() { return { presets: structuredClone(state.presets) }; },
    async createInstructionPreset(name, text) {
      log('createInstructionPreset', name);
      const preset = { id: `p${nextId++}`, name, text, revision: 1, updatedAt: 0, usedBy: [] };
      state.presets.push(preset);
      return preset;
    },
    async updateInstructionPreset(id, revision, name, text) {
      const preset = state.presets.find(p => p.id === id);
      Object.assign(preset, { name, text, revision: revision + 1 });
      return { preset, sync: [] };
    },
    async getCliInstructions(provider) {
      const doc = state.instructions[provider];
      return doc ? { path: provider, exists: true, revision: `r-${doc.text}`, text: doc.text, presetId: doc.presetId, drifted: false }
        : { path: provider, exists: false, revision: 'missing', text: '', drifted: false };
    },
    async writeCliInstructions(provider, revision, text) {
      log('writeCliInstructions', provider);
      state.instructions[provider] = { text };
      return {};
    },
    async setCliInstructionsSource(provider, revision, presetId) {
      log('setCliInstructionsSource', provider, presetId);
      state.instructions[provider] = { text: state.presets.find(p => p.id === presetId).text, presetId };
      return {};
    },
    async getCliSettings(provider) {
      const settings = state.cliSettings[provider];
      return settings ? { path: provider, format: 'json', exists: true, revision: 'rev', text: '', settings: structuredClone(settings) }
        : { path: provider, format: 'json', exists: false, revision: 'missing', text: '', settings: {} };
    },
    async patchCliSettings(provider, revision, patch) {
      log('patchCliSettings', provider, patch);
      const apply = (target, p) => {
        for (const [k, v] of Object.entries(p)) {
          if (v === null) delete target[k];
          else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) apply(target[k], v);
          else target[k] = structuredClone(v);
        }
      };
      state.cliSettings[provider] ??= {};
      apply(state.cliSettings[provider], patch);
      return {};
    },
    async listMcpCatalog(provider) {
      const servers = Object.entries(state.mcp[provider] ?? {}).map(([name, config]) => ({
        resourceId: `res-${provider}-${name}`, name, provider, scope: 'user', source: 'provider', transport: 'stdio', enabled: true, active: true,
      }));
      return { provider, servers, editable: true };
    },
    async getMcpServerConfig(provider, workspace, resourceId) {
      const name = resourceId.slice(`res-${provider}-`.length);
      return { descriptor: {}, path: '', format: 'json', config: structuredClone(state.mcp[provider][name]) };
    },
    async createMcpServer(provider, workspace, input) {
      log('createMcpServer', provider, input.name, input.scope);
      (state.mcp[provider] ??= {})[input.name] = structuredClone(input.config);
      return {};
    },
    async updateMcpServer(provider, workspace, resourceId, input) {
      log('updateMcpServer', provider, input.name);
      state.mcp[provider][input.name] = structuredClone(input.config);
      return {};
    },
    async listSkillCatalog(provider) {
      const skills = Object.values(state.skills)
        .filter(skill => skill.source === 'shared-user' || skill.provider === provider)
        .map(skill => ({ resourceId: `res-${skill.source}-${skill.name}`, name: skill.name, description: '', scope: 'user', source: skill.source, active: true, valid: true, ...(skill.builtIn ? { builtIn: true } : {}) }));
      return { provider, skills, editable: true, creatableSources: ['shared-user', 'provider-user'] };
    },
    async getSkillResource(provider, workspace, resourceId) {
      const skill = Object.values(state.skills).find(s => `res-${s.source}-${s.name}` === resourceId);
      return { resourceId, content: Buffer.from(skill.files.find(f => f.path === 'SKILL.md').contentBase64, 'base64').toString() };
    },
    async getSkillBundle(provider, workspace, resourceId) {
      if (!state.bundles) throw notFound();
      const skill = Object.values(state.skills).find(s => `res-${s.source}-${s.name}` === resourceId);
      return { resourceId, name: skill.name, source: skill.source, files: structuredClone(skill.files), skipped: [] };
    },
    async replaceSkillBundle(provider, workspace, resourceId, files) {
      if (!state.bundles) throw notFound();
      log('replaceSkillBundle', resourceId);
      const skill = Object.values(state.skills).find(s => `res-${s.source}-${s.name}` === resourceId);
      skill.files = structuredClone(files);
      return {};
    },
    async createSkillBundle(provider, workspace, input) {
      if (!state.bundles) throw notFound();
      log('createSkillBundle', provider, input.source, input.name);
      state.skills[`${input.source}:${input.name}`] = { provider, source: input.source, name: input.name, files: structuredClone(input.files) };
      return {};
    },
    async createSkill(provider, workspace, input) {
      log('createSkill', input.name);
      state.skills[`${input.source}:${input.name}`] = { provider, source: input.source, name: input.name, files: [{ path: 'SKILL.md', contentBase64: b64(input.content), executable: false }] };
      return {};
    },
    async updateSkill() { throw new Error('unused'); },
    async listSshHosts() { return { hosts: structuredClone(state.hosts), ftpSites: [] }; },
    async listSshKeys() { return { sshDirectory: '/home/u/.ssh', agentAvailable: false, keys: structuredClone(state.keys) }; },
    async createSshHost(host) {
      log('createSshHost', structuredClone(host));
      state.hosts.push({ alias: host.alias, source: 'managed', agentAccess: false, managed: structuredClone(host) });
      return { host };
    },
    async updateSshHost(alias, host) {
      log('updateSshHost', structuredClone(host));
      state.hosts.find(h => h.alias === alias).managed = structuredClone(host);
      return { host };
    },
  };
  return { api, workspace: '/scratch', state };
}

async function planBetween(source, target, categories, baseline) {
  const [from, to] = await Promise.all([
    sync.collectConfigSync(source, categories),
    sync.collectConfigSync(target, categories),
  ]);
  return { from, to, entries: sync.planConfigSync(from, to, baseline) };
}

/** Plans, applies every selectable entry, and returns the next baseline. */
async function syncAll(source, target, categories, baseline = {}) {
  const { entries } = await planBetween(source, target, categories, baseline);
  const chosen = entries.filter(entry => sync.isConfigSyncSelectable(entry.status));
  const results = await sync.applyConfigSync(target, chosen);
  const after = await sync.collectConfigSync(target, categories);
  return { entries, results, baseline: sync.nextConfigSyncBaseline(baseline, entries, results, after) };
}

test('canonical hashing ignores key order and undefined fields', () => {
  assert.equal(sync.configSyncHash({ a: 1, b: { c: 2, d: undefined } }), sync.configSyncHash({ b: { c: 2 }, a: 1 }));
  assert.notEqual(sync.configSyncHash({ a: 1 }), sync.configSyncHash({ a: 2 }));
});

test('mergePatchBetween nulls removed keys and diffs nested objects', () => {
  assert.deepEqual(
    sync.mergePatchBetween({ allow: ['a'], keep: 1, nested: { x: 1, y: 2 } }, { allow: ['a', 'b'], keep: 1, nested: { x: 1 } }),
    { allow: ['a', 'b'], nested: { y: null } },
  );
  assert.equal(sync.mergePatchBetween({ a: 1 }, 'text'), 'text');
});

test('plan statuses follow the three-way baseline', () => {
  const item = (key, hash) => ({ key, category: 'settings', kind: 'sshSettings', group: '', label: key, hash, payload: null, warnings: [] });
  const source = { categories: ['settings'], errors: [], items: [item('new', 's'), item('same', 'x'), item('first', 's'), item('srcOnly', 's2'), item('tgtOnly', 's'), item('both', 's2'), item('gone', 's')] };
  const target = { categories: ['settings'], errors: [], items: [item('same', 'x'), item('first', 't'), item('srcOnly', 't'), item('tgtOnly', 't2'), item('both', 't2'), item('extra', 'e')] };
  const baseline = { srcOnly: { source: 's', target: 't' }, tgtOnly: { source: 's', target: 't' }, both: { source: 's', target: 't' }, gone: { source: 's', target: 's' } };
  const entries = sync.planConfigSync(source, target, baseline);
  assert.deepEqual(
    Object.fromEntries(entries.map(entry => [entry.key, [entry.status, entry.selected]])),
    {
      new: ['new', true],
      same: ['same', false],
      first: ['update', true],
      srcOnly: ['update', true],
      tgtOnly: ['targetChanged', false],
      both: ['conflict', false],
      gone: ['targetChanged', false],
    },
  );
});

test('settings sync writes changed values, keeps excluded keys, and is a no-op the second time', async () => {
  const source = fakeBackend({
    sshSettings: { serverAliveEnabled: true, serverAliveInterval: 60, serverAliveCountMax: 3 },
    presets: [{ id: 'src1', name: 'Team', text: 'be brief', revision: 3, updatedAt: 0, usedBy: [] }],
    instructions: { 'claude-code': { text: 'be brief', presetId: 'src1' }, codex: { text: 'own text' } },
    cliSettings: { 'claude-code': { env: { ANTHROPIC_AUTH_TOKEN: 'secret' }, permissions: { allow: ['Bash'] }, theme: 'dark' } },
  });
  const target = fakeBackend({
    cliSettings: { 'claude-code': { env: { ANTHROPIC_AUTH_TOKEN: 'other' }, permissions: { allow: ['Read'], deny: ['x'] } } },
  });

  const first = await syncAll(source, target, ['settings']);
  assert.ok(first.results.every(result => result.ok), JSON.stringify(first.results));
  assert.equal(target.state.sshSettings.serverAliveInterval, 60);
  assert.deepEqual(target.state.cliSettings['claude-code'], {
    env: { ANTHROPIC_AUTH_TOKEN: 'other' },
    permissions: { allow: ['Bash'] },
    theme: 'dark',
  });
  // The preset is created before the instructions follow it by name.
  const preset = target.state.presets.find(p => p.name === 'Team');
  assert.ok(preset);
  assert.equal(target.state.instructions['claude-code'].presetId, preset.id);
  assert.equal(target.state.instructions.codex.text, 'own text');
  assert.ok(!first.entries.some(entry => entry.key === 'settings:cli:claude-code:env'));

  target.state.calls.length = 0;
  const second = await planBetween(source, target, ['settings'], first.baseline);
  assert.deepEqual(second.entries.filter(entry => entry.status !== 'same').map(entry => entry.key), []);
});

test('target-side edits are reported, not overwritten', async () => {
  const source = fakeBackend();
  const target = fakeBackend();
  const { baseline } = await syncAll(source, target, ['settings']);
  target.state.agentLocal = { enabled: true };
  const { entries } = await planBetween(source, target, ['settings'], baseline);
  const entry = entries.find(e => e.key === 'settings:agentLocal');
  assert.equal(entry.status, 'targetChanged');
  assert.equal(entry.selected, false);
  source.state.agentLocal = { enabled: false, extra: 1 };
  const again = await planBetween(source, target, ['settings'], baseline);
  assert.equal(again.entries.find(e => e.key === 'settings:agentLocal').status, 'conflict');
});

test('accounts import per agent in one request, carrying secrets', async () => {
  const source = fakeBackend({
    providers: {
      codex: [{ id: 'openai', name: 'OpenAI', settingsConfig: { auth: { OPENAI_API_KEY: 'sk-1' } } }, { id: 'proxy', name: 'Proxy', settingsConfig: {} }],
      'claude-code': [{ id: 'anthropic', name: 'Anthropic', settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 't' } } }],
    },
  });
  const target = fakeBackend({ providers: { codex: [{ id: 'proxy', name: 'Proxy', settingsConfig: {} }, { id: 'mine', name: 'Mine', settingsConfig: {} }], 'claude-code': [] } });
  const { entries, results } = await syncAll(source, target, ['accounts']);
  assert.equal(entries.find(e => e.key === 'accounts:codex:proxy').status, 'same');
  assert.ok(results.every(r => r.ok));
  assert.deepEqual(target.state.calls.filter(c => c[0] === 'importAgentProviders'), [
    ['importAgentProviders', 'codex', ['openai']],
    ['importAgentProviders', 'claude-code', ['anthropic']],
  ]);
  assert.equal(target.state.providers.codex.find(p => p.id === 'openai').settingsConfig.auth.OPENAI_API_KEY, 'sk-1');
  assert.ok(target.state.providers.codex.some(p => p.id === 'mine'), 'target-only providers stay');
});

test('MCP servers upsert by provider and name, and warn on home paths', async () => {
  const source = fakeBackend({ mcp: { codex: { github: { command: 'npx', args: ['gh'] }, local: { command: '/home/a/bin/srv' } } } });
  const target = fakeBackend({ mcp: { codex: { github: { command: 'old' } } } });
  const { entries } = await syncAll(source, target, ['mcp']);
  assert.deepEqual(entries.find(e => e.key === 'mcp:codex:local').warnings, ['absolutePath']);
  assert.deepEqual(target.state.calls.map(c => c.slice(0, 3)), [['updateMcpServer', 'codex', 'github'], ['createMcpServer', 'codex', 'local']]);
  assert.deepEqual(target.state.mcp.codex.github, { command: 'npx', args: ['gh'] });
});

test('skills sync whole bundles and fall back to SKILL.md on old daemons', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: b64('---\nname: a\n---\n'), executable: false }, { path: 'run.sh', contentBase64: b64('echo'), executable: true }];
  const source = fakeBackend({ skills: {
    'shared-user:a': { provider: 'codex', source: 'shared-user', name: 'a', files },
    'provider-user:imagegen': { provider: 'codex', source: 'provider-user', name: 'imagegen', files, builtIn: true },
  } });
  const target = fakeBackend();
  const { entries, results } = await syncAll(source, target, ['skills']);
  // A shared skill is listed by every provider but synced once; built-in ones never.
  assert.deepEqual(entries.map(e => e.key), ['skills:shared:a']);
  assert.ok(results.every(r => r.ok));
  assert.deepEqual(target.state.skills['shared-user:a'].files, files);

  const oldTarget = fakeBackend({ bundles: false });
  const failed = await syncAll(source, oldTarget, ['skills']);
  assert.equal(failed.results[0].ok, false, 'a multi-file skill cannot be squeezed into SKILL.md');

  const oneFile = fakeBackend({ skills: { 'shared-user:b': { provider: 'codex', source: 'shared-user', name: 'b', files: [files[0]] } } });
  const fallback = await syncAll(oneFile, oldTarget, ['skills']);
  assert.ok(fallback.results.every(r => r.ok));
  assert.ok(oldTarget.state.calls.some(c => c[0] === 'createSkill'));
});

test('SSH syncs key hosts by fingerprint, never password hosts or keys', async () => {
  const key = (name, fingerprint, usedBy = []) => ({ name, privateKeyPath: `/home/u/.ssh/${name}`, algorithm: 'ssh-ed25519', fingerprint, loadedInAgent: false, usedBy });
  const host = (managed) => ({ alias: managed.alias, source: 'managed', agentAccess: true, managed });
  const source = fakeBackend({
    hosts: [
      host({ alias: 'web', hostName: 'web.example', user: 'deploy', identityFile: '/home/a/.ssh/id_web' }),
      host({ alias: 'db', hostName: 'db.example', authMethod: 'password' }),
      host({ alias: 'ci', hostName: 'ci.example', identityFile: '/home/a/.ssh/id_ci' }),
      { alias: 'cfg', source: 'sshConfig', agentAccess: false },
    ],
    keys: [key('id_web', 'SHA256:web', ['web']), key('id_ci', 'SHA256:ci', ['ci'])],
  });
  const target = fakeBackend({ keys: [key('work_key', 'SHA256:web')] });
  const { entries, results } = await syncAll(source, target, ['ssh']);
  const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
  assert.equal(byKey['ssh:db'].status, 'blocked');
  assert.equal(byKey['ssh:db'].blocked.code, 'passwordAuth');
  assert.equal(byKey['ssh:ci'].blocked.code, 'missingKey');
  assert.equal(byKey['ssh:cfg'], undefined);
  assert.deepEqual(results, [{ key: 'ssh:web', ok: true }]);
  // The host points at the target's own key file with that fingerprint.
  assert.deepEqual(target.state.calls, [['createSshHost', { alias: 'web', hostName: 'web.example', user: 'deploy', authMethod: 'key', identityFile: '/home/u/.ssh/work_key' }]]);
  assert.equal(target.state.hosts[0].agentAccess, false, 'agent access is not synced');
  const payloadText = JSON.stringify(entries.map(e => e.source.payload));
  assert.ok(!/privateKey"/.test(payloadText));

  const again = await planBetween(source, target, ['ssh']);
  assert.equal(again.entries.find(e => e.key === 'ssh:web').status, 'same');
});

test('a route the daemon lacks drops the category silently; other failures are reported', async () => {
  const backend = fakeBackend();
  backend.api.getAgentLocal = async () => { throw notFound(); };
  backend.api.getAgentOutputFilter = async () => { throw new Error('boom'); };
  const snapshot = await sync.collectConfigSync(backend, ['settings']);
  assert.ok(!snapshot.items.some(i => i.kind === 'agentLocal'));
  assert.deepEqual(snapshot.errors, [{ category: 'settings', scope: 'outputFilter', message: 'boom' }]);
});
