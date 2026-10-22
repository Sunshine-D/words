/**
 * .docx 解析
 * docx 是一个 zip，正文在 word/document.xml。
 * 词汇表常见形态是「两列表格」或「每行一条」，所以这里把表格转成 tab 分隔、
 * 段落转成换行，再交给统一的行解析器。
 */
const zipMod = require('../zip');
const wordUtils = require('../word-utils');

function decodeEntities(s) {
  return s
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

function stripTags(xml) {
  return decodeEntities(xml.replace(/<[^>]*>/g, ''));
}

function docxToText(xml) {
  let s = String(xml || '');

  // 表格块：单元格 -> tab，行 -> 换行，单元格内段落 -> 空格
  s = s.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, function (tbl) {
    return tbl
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>/g, ' ')
      .replace(/<\/w:p>/g, ' ')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]*>/g, '');
  });

  // 正文段落
  s = s
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeEntities(s)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function parse(buffer) {
  const zip = new zipMod.Zip(buffer);

  let path = 'word/document.xml';
  if (!zip.has(path)) {
    const found = zip.find(/^word\/document\d*\.xml$/);
    if (!found) throw new Error('这不是有效的 Word 文档（缺少正文）。如果是 .doc 旧格式，请另存为 .docx。');
    path = found;
  }

  const xml = zip.readText(path);
  if (!xml) throw new Error('无法读取 Word 正文');

  const text = docxToText(xml);
  const result = wordUtils.parseText(text);
  result.text = text;
  return result;
}

module.exports = { parse: parse, docxToText: docxToText };
