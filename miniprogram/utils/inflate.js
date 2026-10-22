/**
 * 纯 JS 的 INFLATE 解压（RFC1951 raw deflate）
 * 小程序运行环境没有 zlib / pako，而 docx、xlsx 本质是 zip（deflate 压缩），
 * 因此这里移植了经典的 tinf 解码器，约 200 行，零依赖。
 */

const LEN_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const DIST_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function BitReader(data, pos) {
  this.data = data;
  this.pos = pos || 0;
  this.buf = 0;
  this.cnt = 0;
}

BitReader.prototype.bit = function () {
  if (this.cnt === 0) {
    if (this.pos >= this.data.length) throw new Error('inflate: unexpected end of data');
    this.buf = this.data[this.pos++];
    this.cnt = 8;
  }
  const b = this.buf & 1;
  this.buf >>= 1;
  this.cnt -= 1;
  return b;
};

BitReader.prototype.bits = function (n) {
  let v = 0;
  for (let i = 0; i < n; i++) v |= this.bit() << i;
  return v;
};

function Output(initial) {
  this.buf = new Uint8Array(Math.max(1024, initial || 32768));
  this.len = 0;
}

Output.prototype.ensure = function (extra) {
  const need = this.len + extra;
  if (need <= this.buf.length) return;
  let cap = this.buf.length * 2;
  while (cap < need) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(this.buf.subarray(0, this.len));
  this.buf = next;
};

function buildTree(lengths, num) {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(num);
  for (let i = 0; i < num; i++) {
    const l = lengths[i];
    if (l > 15) throw new Error('inflate: invalid code length');
    counts[l] += 1;
  }
  counts[0] = 0;
  const offs = new Uint16Array(16);
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += counts[i];
  }
  for (let i = 0; i < num; i++) {
    const l = lengths[i];
    if (l) symbols[offs[l]++] = i;
  }
  return { counts: counts, symbols: symbols };
}

function decodeSymbol(st, tree) {
  let sum = 0;
  let cur = 0;
  let len = 0;
  do {
    cur = 2 * cur + st.bit();
    len += 1;
    if (len > 15) throw new Error('inflate: bad huffman code');
    sum += tree.counts[len];
    cur -= tree.counts[len];
  } while (cur >= 0);
  const idx = sum + cur;
  if (idx < 0 || idx >= tree.symbols.length) throw new Error('inflate: symbol out of range');
  return tree.symbols[idx];
}

function inflateBlockData(st, out, litTree, distTree) {
  for (;;) {
    const sym = decodeSymbol(st, litTree);
    if (sym === 256) return;
    if (sym < 256) {
      out.ensure(1);
      out.buf[out.len++] = sym;
      continue;
    }
    const li = sym - 257;
    if (li >= 29) throw new Error('inflate: invalid length symbol');
    const length = LEN_BASE[li] + st.bits(LEN_BITS[li]);

    const dsym = decodeSymbol(st, distTree);
    if (dsym >= 30) throw new Error('inflate: invalid distance symbol');
    const dist = DIST_BASE[dsym] + st.bits(DIST_BITS[dsym]);
    if (dist > out.len) throw new Error('inflate: distance exceeds output');

    out.ensure(length);
    let from = out.len - dist;
    for (let i = 0; i < length; i++) {
      out.buf[out.len++] = out.buf[from++];
    }
  }
}

function fixedTrees() {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30);
  for (let i = 0; i < 30; i++) d[i] = 5;
  return { lit: buildTree(l, 288), dist: buildTree(d, 30) };
}

let FIXED = null;

function dynamicTrees(st) {
  const hlit = st.bits(5) + 257;
  const hdist = st.bits(5) + 1;
  const hclen = st.bits(4) + 4;

  const clLens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = st.bits(3);
  const clTree = buildTree(clLens, 19);

  const total = hlit + hdist;
  const lens = new Uint8Array(total);
  let i = 0;
  while (i < total) {
    const sym = decodeSymbol(st, clTree);
    if (sym < 16) {
      lens[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new Error('inflate: repeat with no previous length');
      const prev = lens[i - 1];
      let n = 3 + st.bits(2);
      while (n-- > 0 && i < total) lens[i++] = prev;
    } else if (sym === 17) {
      let n = 3 + st.bits(3);
      while (n-- > 0 && i < total) lens[i++] = 0;
    } else if (sym === 18) {
      let n = 11 + st.bits(7);
      while (n-- > 0 && i < total) lens[i++] = 0;
    } else {
      throw new Error('inflate: invalid code length symbol');
    }
  }

  const litLens = lens.subarray(0, hlit);
  const distLens = lens.subarray(hlit, total);
  return {
    lit: buildTree(litLens, hlit),
    dist: buildTree(distLens, hdist)
  };
}

/**
 * 解压 raw deflate 数据
 * @param {Uint8Array} data 压缩数据
 * @param {Number} startOffset 起始字节偏移
 * @param {Number} expectedSize 预期解压大小（用于预分配，可省略）
 * @returns {Uint8Array}
 */
function inflateRaw(data, startOffset, expectedSize) {
  const st = new BitReader(data, startOffset || 0);
  const out = new Output(expectedSize || 32768);

  let last = 0;
  while (!last) {
    last = st.bit();
    const type = st.bits(2);

    if (type === 0) {
      // 未压缩块：丢弃当前字节内剩余 bit
      st.buf = 0;
      st.cnt = 0;
      if (st.pos + 4 > data.length) throw new Error('inflate: truncated stored block');
      const len = data[st.pos] | (data[st.pos + 1] << 8);
      const nlen = data[st.pos + 2] | (data[st.pos + 3] << 8);
      st.pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
      if (st.pos + len > data.length) throw new Error('inflate: truncated stored data');
      out.ensure(len);
      out.buf.set(data.subarray(st.pos, st.pos + len), out.len);
      out.len += len;
      st.pos += len;
    } else if (type === 1) {
      if (!FIXED) FIXED = fixedTrees();
      inflateBlockData(st, out, FIXED.lit, FIXED.dist);
    } else if (type === 2) {
      const t = dynamicTrees(st);
      inflateBlockData(st, out, t.lit, t.dist);
    } else {
      throw new Error('inflate: invalid block type');
    }
  }

  return out.buf.subarray(0, out.len);
}

/**
 * 解压带 zlib 头的流（PDF 的 FlateDecode 使用）
 */
function inflateZlib(data, startOffset, expectedSize) {
  let off = startOffset || 0;
  if (data.length > off + 2) {
    const cmf = data[off];
    const flg = data[off + 1];
    // 校验 zlib 头：CM=8，且 (CMF*256+FLG) % 31 == 0
    if ((cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0) {
      off += 2;
      if (flg & 0x20) off += 4; // FDICT
    }
  }
  return inflateRaw(data, off, expectedSize);
}

module.exports = {
  inflateRaw: inflateRaw,
  inflateZlib: inflateZlib
};
