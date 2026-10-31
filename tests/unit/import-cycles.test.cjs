const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const srcDir = path.join(__dirname, '..', '..', 'src');

/** Relative modules a source file needs at run time (type-only imports and re-exports erase). */
function runtimeDependencies(file) {
  const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const deps = new Set();
  const pattern = /^(?:import|export)\s+(?!type\b)([^;]*?)\s*from\s*'\.\/([^']+)'/gms;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces && braces[1].split(',').map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith('type '))) continue;
    deps.add(match[2].replace(/\.ts$/, ''));
  }
  for (const match of source.matchAll(/^import\s+'\.\/([^']+)'/gm)) deps.add(match[1].replace(/\.ts$/, ''));
  return deps;
}

// CommonJS bundles (React Native's Metro) cannot initialize modules that read
// each other's exports while a cycle is still loading; desktop and web never
// notice because Vite keeps ES module live bindings.
test('protocol sources have no runtime import cycles', () => {
  const modules = fs.readdirSync(srcDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).map((file) => file.slice(0, -3));
  const graph = new Map(modules.map((name) => [name, [...runtimeDependencies(`${name}.ts`)].filter((dep) => modules.includes(dep))]));
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (name) => {
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of graph.get(name)) {
      if (state.get(dep) === 'visiting') cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' -> '));
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of modules) if (!state.has(name)) visit(name);
  assert.deepEqual(cycles, []);
});
