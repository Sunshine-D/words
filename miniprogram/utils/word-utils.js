/**
 * 词条识别与清洗
 *
 * 教材 / 老师发的资料格式千奇百怪，这里做统一归一化：
 *   "1. personal  /ˈpɜːsnl/  adj. 私人的"   -> en: personal        cn: adj. 私人的
 *   "abandon	v. 放弃"                    -> en: abandon         cn: v. 放弃
 *   "abandon    放弃，抛弃"                 -> en: abandon         cn: 放弃，抛弃
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

// 常见词性缩写，用于把误闯进英文段落的词性还原到中文
const POS_RE = /^(n|v|vt|vi|adj|adv|prep|pron|conj|num|art|int|aux|abbr|pl|phr)\s*\./i;

// 表头词，直接跳过
const HEADER_WORDS = ['word', 'words', 'english', 'vocabulary', 'no', 'index', 'unit', 'list'];
const HEADER_CN = ['释义', '中文', '词义', '意思', '翻译', '单词', '序号', 'meaning', 'chinese'];

/** 去掉序号、音标、多余空白 */
function stripNoise(line) {
  let s = String(line == null ? '' : line);
  s = s.replace(/\u00a0|\u3000/g, ' ').replace(/[\r\n]+/g, ' ');
  // 音标：/ˈpɜːsnl/ 或 [ˈpɜːsnl]
  s = s.replace(/\/[^/\s][^/]{0,40}\//g, ' ');
  s = s.replace(/\[[^\]\s][^\]]{0,40}\]/g, ' ');
  // 行首序号：1. 1、 1) (1) ①
  s = s.replace(/^\s*\(?\d{1,4}\s*[\.\)、:：]\s*/, '');
  s = s.replace(/^\s*[\u2460-\u2473]\s*/, '');
  s = s.replace(/^\s*[·•\-–—]\s*/, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 判断一段文本是否像英文词条 */
function isEnglishChunk(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 1 || t.length > 42) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  // 允许以字母或缩写点结尾（"personal adj." 会在后续步骤中把词性剥离到释义侧）
  if (!/[A-Za-z.]$/.test(t)) return false;
  // 只允许字母、空格、连字符、撇号、点
  if (!/^[A-Za-z][A-Za-z'’.\-\s]*$/.test(t)) return false;
  // 排除 "adj. xxx" 这类以词性开头的
  if (POS_RE.test(t)) return false;
  return true;
}

function isHeader(en, cn) {
  const e = (en || '').toLowerCase().trim();
  const c = (cn || '').toLowerCase().trim();
  if (HEADER_WORDS.indexOf(e) >= 0) return true;
  if (HEADER_CN.indexOf(c) >= 0) return true;
  if (c === '中文' || c === '释义' || c === '意思') return true;
  return false;
}

/**
 * 解析单行
 * @returns {{en:string, cn:string}|null}
 */
function parseLine(raw) {
  const s = stripNoise(raw);
  if (!s) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  if (!CJK.test(s) && !/\b(n|v|adj|adv|prep|pron|conj)\./i.test(s)) return null;

  let en = '';
  let cn = '';

  // 1) 制表符分隔（Excel 复制粘贴最常见）
  if (s.indexOf('\t') >= 0) {
    const cells = s.split('\t').map(function (x) {
      return x.trim();
    }).filter(function (x) {
      return x.length > 0;
    });
    if (cells.length >= 2) {
      en = cells[0];
      cn = cells.slice(1).join(' ');
    }
  }

  // 2) 竖线分隔
  if (!en && /[|｜]/.test(s)) {
    const parts = s.split(/[|｜]/);
    if (parts.length >= 2) {
      en = parts[0].trim();
      cn = parts.slice(1).join(' ').trim();
    }
  }

  // 3) 两个及以上空格
  if (!en) {
    const m = s.match(/^([A-Za-z][A-Za-z'’.\-\s]{0,45}?)\s{2,}(.+)$/);
    if (m && isEnglishChunk(m[1])) {
      en = m[1].trim();
      cn = m[2].trim();
    }
  }

  // 4) 英文与中文直接相邻（PDF 提取的典型形态）
  if (!en) {
    const m = s.match(/^([A-Za-z][^\u3400-\u4dbf\u4e00-\u9fff]{0,45}?)\s*([\u3400-\u4dbf\u4e00-\u9fff].*)$/);
    if (m && isEnglishChunk(m[1])) {
      en = m[1].trim();
      cn = m[2].trim();
    }
  }

  // 5) 兜底：中文在前、英文在后（"私人的 —— personal"）
  if (!en) {
    const m = s.match(/^(.+?)\s*[—\-–:：]+\s*([A-Za-z][A-Za-z'’.\-\s]{0,45})$/);
    if (m && isEnglishChunk(m[2])) {
      en = m[2].trim();
      cn = m[1].trim();
    }
  }

  if (!en || !cn) return null;

  en = en.replace(/\s+/g, ' ').trim();
  cn = cn.replace(/\s+/g, ' ').trim();
  cn = cn.replace(/^[\s:：\-–—,，;；]+/, '').trim();
  cn = cn.replace(/[\s:：\-–—,，;；]+$/, '').trim();

  // 词性被识别进英文段的情况："personal adj. 私人的"
  const posInEn = en.match(/^(.*?)\s+(n|v|vt|vi|adj|adv|prep|pron|conj|num|art|int|aux)\.$/i);
  if (posInEn && posInEn[1]) {
    en = posInEn[1].trim();
    cn = posInEn[2] + '. ' + cn;
  }

  if (!isEnglishChunk(en)) return null;
  if (!cn) return null;
  if (isHeader(en, cn)) return null;
  // 中文过短且无词性，多半是页码/表头残留
  if (cn.length > 60) cn = cn.slice(0, 60);

  return { en: en, cn: cn };
}

/**
 * 批量解析纯文本
 * @param {String} text
 * @returns {{words:Array, total:Number, skipped:Array<String>}}
 */
function parseText(text) {
  const lines = String(text || '')
    .replace(/\uFEFF/g, '')
    .split(/\r\n|\r|\n/);
  const words = [];
  const skipped = [];
  const seen = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const item = parseLine(line);
    if (!item) {
      if (line.trim().length > 1 && line.trim().length < 80) skipped.push(line.trim());
      continue;
    }
    const key = item.en.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    words.push(item);
  }

  return { words: words, total: lines.length, skipped: skipped };
}

/**
 * 解析二维表格（Excel）
 * @param {Array<Array<String>>} rows
 */
function parseRows(rows) {
  if (!rows || !rows.length) return { words: [], total: 0, skipped: [] };

  // 找表头行，确定列序
  let enCol = 0;
  let cnCol = 1;
  let startRow = 0;

  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i] || [];
    const cells = row.map(function (c) {
      return String(c || '').toLowerCase().trim();
    });
    let foundEn = -1;
    let foundCn = -1;
    for (let j = 0; j < cells.length; j++) {
      if (foundEn < 0 && /^(word|english|单词|英文|词汇|词组)$/.test(cells[j])) foundEn = j;
      if (foundCn < 0 && /^(meaning|chinese|中文|释义|词义|意思|翻译)$/.test(cells[j])) foundCn = j;
    }
    if (foundEn >= 0 || foundCn >= 0) {
      if (foundEn >= 0) enCol = foundEn;
      if (foundCn >= 0) cnCol = foundCn;
      startRow = i + 1;
      break;
    }
  }

  // 若默认列序反了（第一列是中文），自动交换
  if (startRow === 0) {
    let cnFirst = 0;
    let enFirst = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const row = rows[i] || [];
      if (CJK.test(String(row[0] || ''))) cnFirst++;
      if (/^[A-Za-z]/.test(String(row[0] || '').trim())) enFirst++;
    }
    if (cnFirst > enFirst) {
      enCol = 1;
      cnCol = 0;
    }
  }

  const words = [];
  const skipped = [];
  const seen = {};

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i] || [];
    let en = String(row[enCol] == null ? '' : row[enCol]).trim();
    let cn = String(row[cnCol] == null ? '' : row[cnCol]).trim();

    if (!en && !cn) continue;

    // 单元格内自带 "单词 释义"
    if (en && !cn && CJK.test(en)) {
      const parsed = parseLine(en);
      if (parsed) {
        en = parsed.en;
        cn = parsed.cn;
      }
    }
    if (en && cn && !/[A-Za-z]/.test(en) && /[A-Za-z]/.test(cn)) {
      const t = en;
      en = cn;
      cn = t;
    }

    en = stripNoise(en);
    if (!isEnglishChunk(en) || !cn) {
      if (en || cn) skipped.push(en + (cn ? ' | ' + cn : ''));
      continue;
    }
    const key = en.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    words.push({ en: en, cn: cn });
  }

  return { words: words, total: rows.length, skipped: skipped };
}

module.exports = {
  stripNoise: stripNoise,
  isEnglishChunk: isEnglishChunk,
  parseLine: parseLine,
  parseText: parseText,
  parseRows: parseRows
};
