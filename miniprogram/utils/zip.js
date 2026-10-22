/**
 * 极简 ZIP 读取器（支持 store / deflate）
 * 用于解析 .docx 与 .xlsx —— 二者都是 OOXML 容器（zip 包）
 */
const inflate = require('./inflate');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new Error('zip: 不支持的数据类型');
}

/** UTF-8 字节 -> 字符串 */
function utf8Decode(bytes) {
  const out = [];
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out.push(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      const b1 = bytes[i++];
      out.push(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out.push(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if (b0 >= 0xf0) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      cp -= 0x10000;
      out.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    // 非法字节直接跳过
  }
  // 分块拼接，避免超长字符逐个拼接的性能问题
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < out.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, out.slice(i, i + CHUNK));
  }
  return s;
}

function findEOCD(bytes) {
  const min = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

function u16(b, p) {
  return b[p] | (b[p + 1] << 8);
}
function u32(b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

function Zip(buf) {
  this.bytes = toBytes(buf);
  this.entries = {};
  this.names = [];
  this._parse();
}

Zip.prototype._parse = function () {
  const b = this.bytes;
  const eocd = findEOCD(b);
  if (eocd < 0) throw new Error('zip: 不是有效的压缩文件');

  const total = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);

  for (let i = 0; i < total; i++) {
    if (u32(b, p) !== SIG_CEN) break;
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const rawSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOff = u32(b, p + 42);

    let name = '';
    for (let k = 0; k < nameLen; k++) {
      name += String.fromCharCode(b[p + 46 + k]);
    }
    // 文件名可能为 UTF-8 编码（含中文）
    if (/[\u0080-\u00ff]/.test(name)) {
      name = utf8Decode(b.subarray(p + 46, p + 46 + nameLen));
    }

    this.entries[name] = {
      name: name,
      method: method,
      compSize: compSize,
      rawSize: rawSize,
      localOff: localOff
    };
    this.names.push(name);

    p += 46 + nameLen + extraLen + commentLen;
  }
};

Zip.prototype.list = function () {
  return this.names.slice();
};

Zip.prototype.has = function (name) {
  return !!this.entries[name];
};

Zip.prototype.find = function (pattern) {
  for (let i = 0; i < this.names.length; i++) {
    if (pattern.test(this.names[i])) return this.names[i];
  }
  return null;
};

/** 读取条目为字节数组 */
Zip.prototype.read = function (name) {
  const e = this.entries[name];
  if (!e) return null;
  const b = this.bytes;
  const p = e.localOff;
  if (u32(b, p) !== SIG_LOC) throw new Error('zip: 文件头损坏');
  const nameLen = u16(b, p + 26);
  const extraLen = u16(b, p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = Math.min(b.length, start + e.compSize);
  const raw = b.subarray(start, end);

  if (e.method === 0) return raw;
  if (e.method === 8) return inflate.inflateRaw(raw, 0, e.rawSize);
  throw new Error('zip: 不支持的压缩方式 ' + e.method);
};

/** 读取条目为 UTF-8 文本 */
Zip.prototype.readText = function (name) {
  const bytes = this.read(name);
  if (!bytes) return null;
  return utf8Decode(bytes);
};

module.exports = {
  Zip: Zip,
  utf8Decode: utf8Decode
};
