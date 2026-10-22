/**
 * .pdf 文本层提取（尽力而为）
 *
 * PDF 不是"文档"，而是一堆绘图指令。这里做三件事：
 *   1. 扫描所有 stream，FlateDecode 的先解压
 *   2. 解析 ToUnicode CMap，把 CID 映射回真正的字符（中文必需）
 *   3. 按 BT/ET 文本块 + Td/Tm 坐标变化还原行结构
 *
 * 说明：扫描件（纯图片）没有文本层，无法提取；遇到这种情况会明确提示用户。
 */
const inflate = require('../inflate');
const wordUtils = require('../word-utils');
const zipMod = require('../zip');

const utf8Decode = zipMod.utf8Decode;

function bytesToLatin1(bytes, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(bytes.length, end == null ? bytes.length : end);
  let out = '';
  const CHUNK = 8192;
  for (let i = s; i < e; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(e, i + CHUNK));
    out += String.fromCharCode.apply(null, sub);
  }
  return out;
}

/** 解析 ToUnicode CMap */
function parseCMap(text) {
  const map = {};
  let codeBytes = 2;

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfcharRe.exec(text))) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e;
    while ((e = re.exec(m[1]))) {
      const src = e[1].toUpperCase();
      codeBytes = Math.max(1, Math.round(src.length / 2));
      map[src] = hexToUnicode(e[2]);
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(text))) {
    const block = m[1];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let e;
    while ((e = re.exec(block))) {
      const start = parseInt(e[1], 16);
      const end = parseInt(e[2], 16);
      const srcLen = e[1].length;
      codeBytes = Math.max(1, Math.round(srcLen / 2));
      if (e[3]) {
        const base = e[3];
        const baseVal = parseInt(base, 16);
        for (let c = start; c <= end && c - start < 512; c++) {
          const key = padHex(c, srcLen);
          const dst = (baseVal + (c - start)).toString(16);
          map[key] = hexToUnicode(padHex(parseInt(dst, 16), Math.max(4, base.length)));
        }
      } else if (e[4]) {
        const items = e[4].match(/<([0-9A-Fa-f]+)>/g) || [];
        for (let i = 0; i < items.length && start + i <= end; i++) {
          const key = padHex(start + i, srcLen);
          map[key] = hexToUnicode(items[i].replace(/[<>]/g, ''));
        }
      }
    }
  }

  return { map: map, codeBytes: codeBytes, count: Object.keys(map).length };
}

function padHex(n, len) {
  let s = n.toString(16).toUpperCase();
  while (s.length < len) s = '0' + s;
  return s;
}

function hexToUnicode(hex) {
  const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(parseInt(clean.substr(i, 4), 16));
  }
  if (!out && clean.length === 2) {
    out = String.fromCharCode(parseInt(clean, 16));
  }
  return out;
}

function decodeLiteral(raw) {
  let s = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '(' || n === ')' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      for (let k = 0; k < 2; k++) {
        const nx = s[i + 1];
        if (nx >= '0' && nx <= '7') {
          oct += nx;
          i += 1;
        } else break;
      }
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (n) {
      out += n;
    }
  }
  return out;
}

function decodeHex(hex, cmapInfo) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (cmapInfo && cmapInfo.count > 0) {
    const step = cmapInfo.codeBytes * 2;
    let out = '';
    let hit = 0;
    for (let i = 0; i + step <= clean.length; i += step) {
      const key = clean.substr(i, step).toUpperCase();
      if (cmapInfo.map[key] != null) {
        out += cmapInfo.map[key];
        hit += 1;
      }
    }
    if (hit > 0) return out;
  }
  return hexToUnicode(clean);
}

const TOKEN_RE = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/<>\[\](){}]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g;

/** 内容流 -> 文本行 */
function contentToLines(content, cmapInfo) {
  const lines = [];
  let cur = '';
  let lastY = null;
  let curY = null;

  const stack = [];
  const arrStack = [];

  function pushString(s) {
    if (!s) return;
    if (arrStack.length) {
      arrStack[arrStack.length - 1].push(s);
    } else {
      stack.push(s);
    }
  }

  function newline() {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    cur = '';
  }

  function append(s) {
    if (!s) return;
    cur += s;
  }

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(content))) {
    const tk = m[0];

    if (tk === '[') {
      arrStack.push([]);
      continue;
    }
    if (tk === ']') {
      const arr = arrStack.pop() || [];
      if (arrStack.length) arrStack[arrStack.length - 1].push(arr);
      else stack.push(arr);
      continue;
    }

    const c0 = tk.charCodeAt(0);
    // 字符串
    if (c0 === 40) {
      pushString(decodeLiteral(tk));
      continue;
    }
    if (c0 === 60 && tk.length > 2) {
      pushString(decodeHex(tk.slice(1, -1), cmapInfo));
      continue;
    }
    // 数字
    if (/^[-+]?\d*\.?\d+$/.test(tk)) {
      stack.push(parseFloat(tk));
      continue;
    }
    // 名字对象 / 空串
    if (tk === '<>') {
      pushString('');
      continue;
    }
    if (c0 === 47) {
      stack.push({ name: tk.slice(1) });
      continue;
    }

    // 操作符
    const op = tk;
    if (op === 'Tj') {
      const s = stack[stack.length - 1];
      if (typeof s === 'string') append(s);
      stack.length = 0;
    } else if (op === 'TJ') {
      const arr = stack[stack.length - 1];
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          if (typeof arr[i] === 'string') append(arr[i]);
        }
      }
      stack.length = 0;
    } else if (op === "'" || op === '"') {
      newline();
      const s = stack[stack.length - 1];
      if (typeof s === 'string') append(s);
      stack.length = 0;
    } else if (op === 'Td' || op === 'TD') {
      const y = stack[stack.length - 1];
      if (typeof y === 'number') {
        // 同一 y 视为同一行（英文与中文常用两个文本块分别绘制）
        if (curY === null || Math.abs(y - curY) > 0.5) newline();
        else append(' ');
        curY = y;
      }
      stack.length = 0;
    } else if (op === 'Tm') {
      const f = stack[stack.length - 1];
      if (typeof f === 'number') {
        if (lastY === null || Math.abs(f - lastY) > 0.5) newline();
        else append(' ');
        lastY = f;
        curY = f;
      }
      stack.length = 0;
    } else if (op === 'T*') {
      newline();
      stack.length = 0;
    } else if (op === 'BT') {
      // 不清空 cur、不换行：同一个视觉行可能由多个 BT 块拼成
      stack.length = 0;
      lastY = null;
    } else if (op === 'ET') {
      stack.length = 0;
    } else if (op === 'Do' || op === 're' || op === 'cm' || op === 'q' || op === 'Q') {
      stack.length = 0;
    } else {
      stack.length = 0;
    }
  }
  newline();
  return lines;
}

function parse(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 30 * 1024 * 1024) {
    throw new Error('PDF 文件过大（超过 30MB），建议拆分后再导入');
  }

  const latin = bytesToLatin1(bytes, 0, bytes.length);
  const contentChunks = [];
  const cmapTexts = [];

  let idx = 0;
  let guard = 0;
  while (idx < latin.length && guard < 5000) {
    guard += 1;
    const sIdx = latin.indexOf('stream', idx);
    if (sIdx < 0) break;

    // "endstream" 里也包含 "stream"，排除
    if (latin.substr(sIdx - 3, 3) === 'end') {
      idx = sIdx + 6;
      continue;
    }

    const dictStart = Math.max(0, sIdx - 1200);
    const dict = latin.slice(dictStart, sIdx);

    let dataStart = sIdx + 6;
    if (latin.charCodeAt(dataStart) === 13) dataStart += 1;
    if (latin.charCodeAt(dataStart) === 10) dataStart += 1;

    const eIdx = latin.indexOf('endstream', dataStart);
    if (eIdx < 0) break;

    let data = bytes.subarray(dataStart, eIdx);

    const isFlate = /\/FlateDecode/.test(dict);
    if (isFlate) {
      try {
        data = inflate.inflateZlib(data, 0, 0);
      } catch (e) {
        idx = eIdx + 9;
        continue;
      }
    }

    if (data.length && data.length < 12 * 1024 * 1024) {
      const chunk = utf8OrLatin(data);
      if (chunk.indexOf('beginbfchar') >= 0 || chunk.indexOf('beginbfrange') >= 0) {
        cmapTexts.push(chunk);
      } else if (chunk.indexOf('BT') >= 0 && (chunk.indexOf('Tj') >= 0 || chunk.indexOf('TJ') >= 0)) {
        contentChunks.push(chunk);
      }
    }

    idx = eIdx + 9;
  }

  let cmapInfo = { map: {}, codeBytes: 2, count: 0 };
  for (let i = 0; i < cmapTexts.length; i++) {
    try {
      const one = parseCMap(cmapTexts[i]);
      if (one.count > cmapInfo.count) cmapInfo = one;
    } catch (e) {
      /* ignore */
    }
  }

  let allLines = [];
  for (let i = 0; i < contentChunks.length; i++) {
    const lines = contentToLines(contentChunks[i], cmapInfo);
    allLines = allLines.concat(lines);
  }

  const text = allLines.join('\n');
  const result = wordUtils.parseText(text);
  result.text = text;
  result.cmapCount = cmapInfo.count;

  if (!result.words.length) {
    const err = new Error(
      'PDF 里没有提取到可用的「单词 + 中文」对照。\n可能原因：① 这是扫描件/图片；② 是横排多列表格导致顺序错乱。\n建议：用「粘贴文本」直接贴入词表，或改用 Excel / Word 文件。'
    );
    err.code = 'PDF_EMPTY';
    err.rawText = text;
    throw err;
  }

  return result;
}

/** 解压后的流可能是 UTF-8（罕见）也可能是 PDF 的 latin1 指令 */
function utf8OrLatin(data) {
  const sample = data.subarray(0, Math.min(4000, data.length));
  let high = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] > 127) high += 1;
  }
  // 指令流基本都是 ASCII，少量高位字节属于字符串字面量
  if (high / Math.max(1, sample.length) > 0.3) {
    return utf8Decode(data);
  }
  return bytesToLatin1(data, 0, data.length);
}

module.exports = { parse: parse, contentToLines: contentToLines, parseCMap: parseCMap };
