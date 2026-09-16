const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiledDir = path.join(__dirname, '..', '..', 'dist', 'unit');
const catalog = require(path.join(compiledDir, 'lib', 'capabilityCatalog.js'));

function skill(overrides = {}) {
  return {
    resourceId: 'res_skill_1',
    name: 'code-review',
    description: 'Reviews code changes',
    scope: 'project',
    source: 'shared',
    active: true,
    valid: true,
    ...overrides,
  };
}

function mcp(overrides = {}) {
  return {
    resourceId: 'res_mcp_1',
    name: 'github',
    provider: 'codex',
    scope: 'user',
    source: 'shared',
    transport: 'http',
    enabled: true,
    active: true,
    ...overrides,
  };
}

test('filters invalid skills and disabled MCP servers', () => {
  const catalogs = {
    codex: {
      status: 'ready',
      skills: { provider: 'codex', skills: [skill(), skill({ resourceId: 'res_bad', name: 'broken', valid: false })] },
      mcp: { provider: 'codex', servers: [mcp(), mcp({ resourceId: 'res_off', name: 'disabled-srv', enabled: false })] },
    },
  };
  const items = catalog.buildCapabilitySuggestions(catalogs, ['codex'], '');
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'skill');
  assert.equal(items[0].name, 'code-review');
  assert.equal(items[1].kind, 'mcp');
  assert.equal(items[1].name, 'github');
});

test('matches the query against name and description case-insensitively', () => {
  const catalogs = {
    codex: {
      status: 'ready',
      skills: {
        provider: 'codex',
        skills: [skill(), skill({ resourceId: 'res_2', name: 'deploy', description: 'Ship to prod' })],
      },
      mcp: { provider: 'codex', servers: [mcp({ resourceId: 'res_mcp_2', name: 'linear' })] },
    },
  };
  assert.deepEqual(
    catalog.buildCapabilitySuggestions(catalogs, ['codex'], 'REV').map((item) => item.name),
    ['code-review'],
  );
  assert.deepEqual(
    catalog.buildCapabilitySuggestions(catalogs, ['codex'], 'ship').map((item) => item.name),
    ['deploy'],
  );
  assert.equal(catalog.buildCapabilitySuggestions(catalogs, ['codex'], 'zzz').length, 0);
});

test('deduplicates across providers and honors provider order', () => {
  const catalogs = {
    codex: {
      status: 'ready',
      skills: { provider: 'codex', skills: [skill({ source: 'codex-source' })] },
      mcp: { provider: 'codex', servers: [] },
    },
    'claude-code': {
      status: 'ready',
      skills: { provider: 'claude-code', skills: [skill({ source: 'claude-source' }), skill({ resourceId: 'res_3', name: 'lint' })] },
      mcp: { provider: 'claude-code', servers: [] },
    },
  };
  const items = catalog.buildCapabilitySuggestions(catalogs, ['claude-code', 'codex'], '');
  assert.deepEqual(items.map((item) => item.name), ['code-review', 'lint']);
  assert.equal(items[0].provider, 'claude-code');
  assert.equal(items[0].skill.source, 'claude-source');
});

test('marks attached skills through the predicate and caps the list', () => {
  const skills = Array.from({ length: 12 }, (_, index) =>
    skill({ resourceId: `res_${index}`, name: `skill-${index}` }));
  const catalogs = {
    codex: { status: 'ready', skills: { provider: 'codex', skills }, mcp: { provider: 'codex', servers: [mcp()] } },
  };
  const items = catalog.buildCapabilitySuggestions(catalogs, ['codex'], '', {
    isSkillAttached: (entry) => entry.name === 'skill-1',
  });
  assert.equal(items.length, catalog.CAPABILITY_SUGGESTION_LIMIT);
  assert.equal(items[1].attached, true);
  assert.equal(items[0].attached, false);
});

test('reports pending while any provider catalog is missing or loading', () => {
  assert.equal(catalog.capabilityCatalogsPending({}, ['codex']), true);
  assert.equal(
    catalog.capabilityCatalogsPending({ codex: { status: 'loading' } }, ['codex']),
    true,
  );
  assert.equal(
    catalog.capabilityCatalogsPending({ codex: { status: 'ready' } }, ['codex']),
    false,
  );
  assert.equal(catalog.capabilityCatalogsPending({}, []), false);
});
