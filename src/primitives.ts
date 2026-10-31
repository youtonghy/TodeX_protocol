/**
 * Dependency-free value helpers. `transport.ts` takes them from here rather
 * than from the `todex.ts` barrel, which would close a runtime import cycle
 * (todex → mobileParity → v2 → secureTransport → transport → todex) that
 * CommonJS bundles such as React Native's Metro cannot initialize.
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * UTF-8 byte length of a string. String.length counts UTF-16 code units, which
 * undercounts non-ASCII text, while the backend message limits are in bytes.
 * Counted in place rather than via TextEncoder.encode().length so multi-megabyte
 * frames are not copied on every send.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Well-formed surrogate pair: one code point, four bytes.
        bytes += 4;
        index += 1;
        continue;
      }
      // Lone surrogate; encoders emit U+FFFD, which is three bytes.
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
