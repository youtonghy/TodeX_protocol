const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const lib = path.join(__dirname, '..', '..', 'dist', 'unit', 'lib');
const { BIP39_ENGLISH_WORDLIST } = require(path.join(lib, 'bip39English.js'));
const {
  parseRecoveryKey,
  recoveryQrPayload,
  recoverySeedFromQrPayload,
  recoverySeedFromWords,
  recoveryWordsFromSeed,
} = require(path.join(lib, 'recoveryKey.js'));
const { encodeQrCode } = require(path.join(lib, 'qrCode.js'));

// Official BIP39 vectors (trezor/python-mnemonic vectors.json, English,
// 256-bit entropy).
const VECTORS = [
  ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'],
  ['8080808080808080808080808080808080808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'],
  ['68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c', 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'],
  ['9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863', 'panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside'],
  ['066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad', 'all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform'],
  ['f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f', 'void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold'],
];
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));

test('the wordlist is the 2048-word BIP39 English list', () => {
  assert.equal(BIP39_ENGLISH_WORDLIST.length, 2048);
  assert.equal(new Set(BIP39_ENGLISH_WORDLIST).size, 2048);
  assert.equal(new Set(BIP39_ENGLISH_WORDLIST.map((word) => word.slice(0, 4))).size, 2048);
  assert.equal(require('node:crypto').createHash('sha256').update(`${BIP39_ENGLISH_WORDLIST.join('\n')}\n`).digest('hex'),
    '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('official 256-bit vectors encode and decode', () => {
  for (const [entropy, mnemonic] of VECTORS) {
    assert.equal(recoveryWordsFromSeed(hex(entropy)).join(' '), mnemonic);
    assert.equal(Buffer.from(recoverySeedFromWords(mnemonic)).toString('hex'), entropy);
  }
});

test('word input is forgiving about case, spacing and four-letter prefixes but checks the checksum', () => {
  const [entropy, mnemonic] = VECTORS[4];
  const messy = `  ${mnemonic.toUpperCase().split(' ').map((word) => word.slice(0, 4)).join('\n\t ')} `;
  assert.equal(Buffer.from(recoverySeedFromWords(messy)).toString('hex'), entropy);
  const swapped = mnemonic.split(' ');
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(() => recoverySeedFromWords(swapped), /校验失败/);
  assert.throws(() => recoverySeedFromWords(mnemonic.split(' ').slice(0, 23)), /24 个单词/);
  assert.throws(() => recoverySeedFromWords(mnemonic.replace('hamster', 'hamsterx').replace('diagram', 'qqqq')), /不在 BIP39/);
  assert.throws(() => recoveryWordsFromSeed(new Uint8Array(16)), /长度无效/);
});

test('the QR payload round-trips and parseRecoveryKey accepts both forms', () => {
  const seed = hex(VECTORS[5][0]);
  const payload = recoveryQrPayload(seed);
  assert.match(payload, /^todex-recovery:v1:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(recoverySeedFromQrPayload(payload), seed);
  assert.deepEqual(parseRecoveryKey(` ${payload}\n`), seed);
  assert.deepEqual(parseRecoveryKey(VECTORS[5][1]), seed);
  assert.throws(() => recoverySeedFromQrPayload('todex-recovery:v1:AAAA'), /无效/);
  assert.throws(() => recoverySeedFromQrPayload(`${payload}=`), /无效/);
  assert.throws(() => recoverySeedFromQrPayload('otpauth://x'), /不是/);
  const qr = encodeQrCode(payload);
  assert.equal(qr.size, 33);
  // Finder pattern corners and the always-dark module.
  for (const [x, y] of [[0, 0], [qr.size - 1, 0], [0, qr.size - 1], [8, qr.size - 8]]) assert.equal(qr.modules[y][x], true);
  assert.throws(() => encodeQrCode('x'.repeat(200)), /过长/);
});
