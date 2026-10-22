/**
 * .xlsx 解析
 * 只取第一个工作表，按行还原为二维数组后交给 parseRows。
 * 老师发的单词表 90% 是「两列：英文 / 中文」，这条路成功率最高。
 */
const zipMod = require('../zip');
const wordUtils = require('../word-utils');

function colToIndex(letters) {
  let n = 0;
  const s = String(letters || '').toUpperCase().replace(/[^A-Z]/g, '');
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n - 1;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function (_, num) {
      return String.fromCharCode(parseInt(num, 10));
    })
    .replace(/&amp;/g, '&');
}

/** sharedStrings.xml -> 字符串数组 */
function readSharedStrings(zip) {
  const name = zip.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : zip.find(/sharedStrings\.xml$/);
  if (!name) return [];
  const xml = zip.readText(name) || '';
  const list = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) {
      text += decodeEntities(t[1]);
    }
    list.push(text);
  }
  return list;
}

/** 定位第一个工作表的 xml 路径 */
function findSheetPath(zip) {
  try {
    const wb = zip.readText('xl/workbook.xml');
    const rels = zip.readText('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const sMatch = wb.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*\/?>/);
      const id = sMatch ? sMatch[1] : '';
      if (id) {
        const relRe = new RegExp('<Relationship[^>]*Id="' + id + '"[^>]*>', 'i');
        const rel = rels.match(relRe);
        if (rel) {
          const target = (rel[0].match(/Target="([^"]+)"/) || [])[1] || '';
          if (target) {
            const clean = target.replace(/^\//, '').replace(/^xl\//, '');
            if (zip.has('xl/' + clean)) return 'xl/' + clean;
            if (zip.has(clean)) return clean;
          }
        }
      }
    }
  } catch (e) {
    /* 回退到下面对文件的猜测 */
  }
  if (zip.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  return zip.find(/^xl\/worksheets\/sheet\d*\.xml$/);
}

function readSheetRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rowXml = m[1];
    const cells = {};
    let maxCol = -1;

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    let autoCol = 0;
    while ((c = cellRe.exec(rowXml))) {
      const attrs = c[1] || '';
      const body = c[2] || '';
      const refMatch = attrs.match(/r="([A-Za-z]+)\d+"/);
      const col = refMatch ? colToIndex(refMatch[1]) : autoCol;
      autoCol = col + 1;

      let value = '';
      const vMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      if (/t="s"/.test(attrs) && vMatch) {
        const idx = parseInt(vMatch[1], 10);
        value = shared[idx] == null ? '' : shared[idx];
      } else if (/t="inlineStr"/.test(attrs)) {
        const tMatch = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeEntities(tMatch[1]) : '';
      } else if (vMatch) {
        value = decodeEntities(vMatch[1]);
      } else {
        const tMatch = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        if (tMatch) value = decodeEntities(tMatch[1]);
      }

      value = String(value).replace(/\s+/g, ' ').trim();
      if (value) {
        cells[col] = value;
        if (col > maxCol) maxCol = col;
      }
    }

    if (maxCol < 0) {
      rows.push([]);
      continue;
    }
    const arr = [];
    for (let i = 0; i <= maxCol; i++) {
      arr.push(cells[i] == null ? '' : cells[i]);
    }
    rows.push(arr);
  }
  return rows;
}

function parse(buffer) {
  const zip = new zipMod.Zip(buffer);
  const sheetPath = findSheetPath(zip);
  if (!sheetPath) throw new Error('这个 Excel 里没有找到工作表');

  const shared = readSharedStrings(zip);
  const xml = zip.readText(sheetPath) || '';
  const rows = readSheetRows(xml, shared);

  const result = wordUtils.parseRows(rows);
  result.rows = rows;
  return result;
}

module.exports = { parse: parse, readSheetRows: readSheetRows };
