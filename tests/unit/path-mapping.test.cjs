const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const {
  mapBackendPathToHost,
  mapHostPathToBackend,
  parseBackendDeployment,
  parsePathMappings,
} = require(path.join(lib, 'pathMapping.js'));

const posix = { windows: false };
const windows = { windows: true };

test('POSIX paths map both ways under a mapping', () => {
  const mappings = [{ hostPath: '/Users/me/code', backendPath: '/workspace/code' }];
  assert.equal(mapHostPathToBackend('/Users/me/code', mappings, posix), '/workspace/code');
  assert.equal(mapHostPathToBackend('/Users/me/code/app/src', mappings, posix), '/workspace/code/app/src');
  assert.equal(mapHostPathToBackend('/Users/me/code/app/', mappings, posix), '/workspace/code/app');
  assert.equal(mapBackendPathToHost('/workspace/code/app/README.md', mappings, posix), '/Users/me/code/app/README.md');
  // POSIX names are case-sensitive.
  assert.equal(mapHostPathToBackend('/users/me/code', mappings, posix), null);
});

test('a prefix matches only on whole path segments', () => {
  const mappings = [{ hostPath: '/home/me/code', backendPath: '/workspace/code' }];
  assert.equal(mapHostPathToBackend('/home/me/codebase', mappings, posix), null);
  assert.equal(mapBackendPathToHost('/workspace/code2/x', mappings, posix), null);
  assert.equal(mapHostPathToBackend('/home/me', mappings, posix), null);
});

test('the longest matching prefix wins, whatever the order', () => {
  const mappings = [
    { hostPath: '/home/me', backendPath: '/workspace/home' },
    { hostPath: '/home/me/code/big', backendPath: '/workspace/big' },
  ];
  assert.equal(mapHostPathToBackend('/home/me/code/big/x', mappings, posix), '/workspace/big/x');
  assert.equal(mapHostPathToBackend('/home/me/code/small', mappings, posix), '/workspace/home/code/small');
  assert.equal(mapBackendPathToHost('/workspace/big/x', [...mappings].reverse(), posix), '/home/me/code/big/x');
});

test('Windows host paths ignore case and separator style and come back with backslashes', () => {
  const mappings = [{ hostPath: 'C:\\Users\\Me\\code', backendPath: '/workspace/code' }];
  assert.equal(mapHostPathToBackend('C:\\Users\\Me\\code\\app', mappings, windows), '/workspace/code/app');
  assert.equal(mapHostPathToBackend('c:/users/me/CODE/app', mappings, windows), '/workspace/code/app');
  assert.equal(mapHostPathToBackend('D:\\Users\\Me\\code', mappings, windows), null);
  assert.equal(mapBackendPathToHost('/workspace/code/app/main.rs', mappings, windows), 'C:\\Users\\Me\\code\\app\\main.rs');
  assert.equal(mapBackendPathToHost('/workspace/code', mappings, windows), 'C:\\Users\\Me\\code');
  // The backend side is POSIX: case still matters there.
  assert.equal(mapBackendPathToHost('/Workspace/code', mappings, windows), null);
});

test('UNC shares and drive roots map under Windows', () => {
  const mappings = [
    { hostPath: '\\\\nas\\share\\repos', backendPath: '/workspace/nas' },
    { hostPath: 'E:\\', backendPath: '/workspace/e' },
  ];
  assert.equal(mapHostPathToBackend('\\\\NAS\\share\\repos\\x', mappings, windows), '/workspace/nas/x');
  assert.equal(mapBackendPathToHost('/workspace/nas/x', mappings, windows), '\\\\nas\\share\\repos\\x');
  assert.equal(mapHostPathToBackend('e:\\data', mappings, windows), '/workspace/e/data');
  assert.equal(mapBackendPathToHost('/workspace/e/data', mappings, windows), 'E:\\data');
});

test('identity mappings return the same path', () => {
  const mappings = [{ hostPath: '/home/jh/git', backendPath: '/home/jh/git' }];
  assert.equal(mapHostPathToBackend('/home/jh/git/TodeX', mappings, posix), '/home/jh/git/TodeX');
  assert.equal(mapBackendPathToHost('/home/jh/git/TodeX', mappings, posix), '/home/jh/git/TodeX');
});

test('no match, relative paths, dot segments and bad mappings give null', () => {
  const mappings = [
    { hostPath: '/home/me/code', backendPath: '/workspace/code' },
    { hostPath: 'relative', backendPath: '/workspace/rel' },
    { hostPath: '/home/me/other', backendPath: 'not-absolute' },
  ];
  assert.equal(mapHostPathToBackend('/srv/data', mappings, posix), null);
  assert.equal(mapHostPathToBackend('code/app', mappings, posix), null);
  assert.equal(mapHostPathToBackend('', mappings, posix), null);
  assert.equal(mapHostPathToBackend('/home/me/code/../secret', mappings, posix), null);
  assert.equal(mapHostPathToBackend('/home/me/code/./app', mappings, posix), null);
  assert.equal(mapHostPathToBackend('relative/x', mappings, posix), null);
  assert.equal(mapHostPathToBackend('/home/me/other/x', mappings, posix), null);
  assert.equal(mapHostPathToBackend('/home/me/code', [], posix), null);
});

test('missing version fields fall back to a host backend without mappings', () => {
  assert.equal(parseBackendDeployment(undefined), 'host');
  assert.equal(parseBackendDeployment('host'), 'host');
  assert.equal(parseBackendDeployment('vm'), 'host');
  assert.equal(parseBackendDeployment('container'), 'container');
  assert.deepEqual(parsePathMappings(undefined), []);
  assert.deepEqual(parsePathMappings({ hostPath: '/a', backendPath: '/b' }), []);
  assert.deepEqual(parsePathMappings([
    { hostPath: '/a', backendPath: '/b' },
    { hostPath: '/c' },
    null,
    { hostPath: ' ', backendPath: '/d' },
    { hostPath: 1, backendPath: '/e' },
  ]), [{ hostPath: '/a', backendPath: '/b' }]);
});
