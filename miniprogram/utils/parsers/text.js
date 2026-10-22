/**
 * 纯文本 / CSV / TXT / Markdown 解析
 */
const wordUtils = require('../word-utils');
const zipMod = require('../zip');

const utf8Decode = zipMod.utf8Decode;

/** 粗略判断是否 UTF-8（出现大量 0xFFFD 说明不是） */
function looksLikeUtf8(bytes) {
  let i = 0;
  const len = Math.min(bytes.length, 20000);
  let bad = 0;
  while (i < len) {
    const b = bytes[i];
    if (b < 0x80) {
      i += 1;
    } else if (b >= 0xc2 && b < 0xe0) {
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      i += 3;
    } else if (b >= 0xf0 && b < 0xf5) {
      i += 4;
    } else {
      bad += 1;
      i += 1;
    }
  }
  return bad / Math.max(1, len) < 0.02;
}

/** 简易 CSV 解析（支持引号包裹与转义） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 忽略
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {String} fileName
 */
function parse(buffer, fileName) {
  const bytes = new Uint8Array(buffer);
  if (!looksLikeUtf8(bytes)) {
    const err = new Error('文件编码不是 UTF-8（可能是 GBK/ANSI）。请在 Excel 或记事本中另存为 UTF-8，或直接导入 .xlsx / .docx 文件。');
    err.code = 'ENCODING';
    throw err;
  }

  let text = utf8Decode(bytes);
  text = text.replace(/^\uFEFF/, '');

  const name = String(fileName || '').toLowerCase();
  const isCsv = /\.(csv|tsv)$/.test(name);

  if (isCsv) {
    const rows = parseCsv(text);
    const res = wordUtils.parseRows(rows);
    if (res.words.length) return res;
    // CSV 失败则回退到按行解析
  }

  return wordUtils.parseText(text);
}

module.exports = { parse: parse, parseCsv: parseCsv, looksLikeUtf8: looksLikeUtf8 };
