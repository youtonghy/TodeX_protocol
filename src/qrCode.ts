// Minimal QR Code encoder (ISO/IEC 18004) for short secrets shown on screen:
// byte mode, error correction level M, versions 1-9 (up to 182 bytes). The
// apps only ship a decoder (jsQR); a recovery key must never be sent to a
// third-party QR service, so it is encoded locally.

const MAX_VERSION = 9;
/** Level M, indexed by version. */
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22];
const ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5];
/** Format-information bits of level M. */
const LEVEL_M_FORMAT_BITS = 0;

export type QrMatrix = {
  size: number;
  /** Row-major; `true` is a dark module. No quiet zone. */
  modules: boolean[][];
};

export function encodeQrCode(text: string): QrMatrix {
  const data = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    if (4 + 8 + data.length * 8 <= dataCodewordCount(version) * 8) break;
  }
  if (version > MAX_VERSION) throw new Error('二维码内容过长');

  const capacityBits = dataCodewordCount(version) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let index = length - 1; index >= 0; index--) bits.push((value >>> index) & 1);
  };
  append(0b0100, 4);
  append(data.length, 8);
  for (const byte of data) append(byte, 8);
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }

  const qr = new QrBuilder(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addErrorCorrection(version, codewords));
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    qr.applyMask(mask);
  }
  qr.applyMask(bestMask);
  qr.drawFormatBits(bestMask);
  return { size: qr.size, modules: qr.modules };
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewordCount(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version];
}

function addErrorCorrection(version: number, data: number[]): number[] {
  const blockCount = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  for (let index = 0, offset = 0; index < blockCount; index++) {
    const length = shortBlockLength - eccLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (index < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let index = 0; index < blocks[0].length; index++) {
    blocks.forEach((block, blockIndex) => {
      if (index !== shortBlockLength - eccLength || blockIndex >= shortBlocks) result.push(block[index]);
    });
  }
  return result;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index++) {
    for (let term = 0; term < result.length; term++) {
      result[term] = gfMultiply(result[term], root);
      if (term + 1 < result.length) result[term] ^= result[term + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, index) => { result[index] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function gfMultiply(left: number, right: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((right >>> bit) & 1) * left;
  }
  return product & 0xff;
}

class QrBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(private readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  drawFunctionPatterns(): void {
    for (let index = 0; index < this.size; index++) {
      this.setFunction(6, index, index % 2 === 0);
      this.setFunction(index, 6, index % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((x, i) => positions.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask: number): void {
    const data = (LEVEL_M_FORMAT_BITS << 3) | mask;
    let remainder = data;
    for (let index = 0; index < 10; index++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (index: number) => ((bits >>> index) & 1) !== 0;
    for (let index = 0; index <= 5; index++) this.setFunction(8, index, bit(index));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let index = 9; index < 15; index++) this.setFunction(14 - index, 8, bit(index));
    for (let index = 0; index < 8; index++) this.setFunction(this.size - 1 - index, 8, bit(index));
    for (let index = 8; index < 15; index++) this.setFunction(8, this.size - 15 + index, bit(index));
    this.setFunction(8, this.size - 8, true);
  }

  drawCodewords(data: readonly number[]): void {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let column = 0; column < 2; column++) {
          const x = right - column;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.reserved[y][x] && index < data.length * 8) {
            this.modules[y][x] = ((data[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
            index++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y][x]) continue;
        const invert = mask === 0 ? (x + y) % 2 === 0
          : mask === 1 ? y % 2 === 0
          : mask === 2 ? x % 3 === 0
          : mask === 3 ? (x + y) % 3 === 0
          : mask === 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
          : mask === 5 ? ((x * y) % 2) + ((x * y) % 3) === 0
          : mask === 6 ? (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
          : (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Runs, 2x2 blocks and dark balance (rules 1, 2 and 4); any mask decodes,
   * this only favors the more scannable one. */
  penalty(): number {
    let result = 0;
    const scoreLine = (get: (index: number) => boolean) => {
      let run = 1;
      for (let index = 1; index <= this.size; index++) {
        if (index < this.size && get(index) === get(index - 1)) {
          run++;
          continue;
        }
        if (run >= 5) result += run - 2;
        run = 1;
      }
    };
    let dark = 0;
    for (let line = 0; line < this.size; line++) {
      scoreLine((index) => this.modules[line][index]);
      scoreLine((index) => this.modules[index][line]);
    }
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x]) dark++;
        if (x + 1 < this.size && y + 1 < this.size) {
          const color = this.modules[y][x];
          if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) result += 3;
        }
      }
    }
    const total = this.size * this.size;
    return result + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let index = 0; index < 12; index++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let index = 0; index < 18; index++) {
      const dark = ((bits >>> index) & 1) !== 0;
      const a = this.size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const column = x + dx;
        const row = y + dy;
        if (column >= 0 && column < this.size && row >= 0 && row < this.size) {
          this.setFunction(column, row, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }
}
