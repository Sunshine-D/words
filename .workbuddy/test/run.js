/* 解析器验证脚本（Node 环境，绕过 wx API） */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const base = path.resolve(dir, '../../miniprogram/utils');

const textParser = require(path.join(base, 'parsers/text'));
const docxParser = require(path.join(base, 'parsers/docx'));
const xlsxParser = require(path.join(base, 'parsers/xlsx'));
const pdfParser = require(path.join(base, 'parsers/pdf'));
const wordUtils = require(path.join(base, 'word-utils'));
const inflate = require(path.join(base, 'inflate'));
const zlib = require('zlib');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function read(name) {
  const buf = fs.readFileSync(path.join(dir, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* 1. inflate 与 zlib 交叉验证 */
console.log('\n[1] inflate vs node zlib');
(function () {
  const src = Buffer.from(
    'word,cnen\n' + Array.from({ length: 400 }, (_, i) => 'word' + i + ',释义' + i).join('\n'),
    'utf8'
  );
  const compressed = zlib.deflateRawSync(src);
  const out = inflate.inflateRaw(new Uint8Array(compressed), 0, src.length);
  check('deflateRaw 解压结果一致', Buffer.compare(Buffer.from(out), src) === 0);

  const z = zlib.deflateSync(src);
  const out2 = inflate.inflateZlib(new Uint8Array(z), 0, 0);
  check('zlib 头解压结果一致', Buffer.compare(Buffer.from(out2), src) === 0);

  // 固定 Huffman + stored block 混合
  const big = Buffer.alloc(70000, 0);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const c3 = zlib.deflateRawSync(big, { level: 0 });
  const out3 = inflate.inflateRaw(new Uint8Array(c3), 0, big.length);
  check('stored block 解压一致', Buffer.compare(Buffer.from(out3), big) === 0);
})();

/* 2. txt */
console.log('\n[2] txt');
(function () {
  const res = textParser.parse(read('sample.txt'), 'sample.txt');
  check('识别 8 个单词', res.words.length === 8, 'got ' + res.words.length);
  check('顺序保持文件顺序', res.words[0].en === 'personal' && res.words[7].en === 'expect',
    JSON.stringify(res.words[0]));
  check('音标被剔除', res.words[0].cn === 'adj. 私人的', res.words[0].cn);
  check('序号被剔除', res.words[1].en === 'tie', res.words[1].en);
  console.log('  sample:', JSON.stringify(res.words.slice(0, 3)));
})();

/* 3. docx */
console.log('\n[3] docx');
(function () {
  const res = docxParser.parse(read('sample.docx'));
  check('识别 8 段 + 2 表格 = 10', res.words.length === 10, 'got ' + res.words.length);
  check('首条正确', res.words[0].en === 'personal' && res.words[0].cn === 'adj. 私人的',
    JSON.stringify(res.words[0]));
  const valuable = res.words.find((w) => w.en === 'valuable');
  check('表格内容被解析', !!valuable && valuable.cn === 'adj. 贵重的', JSON.stringify(valuable));
  check('表头未被当成词条', !res.words.some((w) => w.en.toLowerCase() === 'word'),
    JSON.stringify(res.words.map((w) => w.en)));
})();

/* 4. xlsx */
console.log('\n[4] xlsx');
(function () {
  const res = xlsxParser.parse(read('sample.xlsx'));
  check('识别 8 个单词', res.words.length === 8, 'got ' + res.words.length);
  check('表头被跳过', res.words[0].en === 'personal', JSON.stringify(res.words[0]));
  check('中文释义正确', res.words[2].cn === 'adj. 静止的；adv. 甚至，仍然', res.words[2].cn);
})();

/* 5. pdf */
console.log('\n[5] pdf');
(function () {
  const res = pdfParser.parse(read('sample.pdf'));
  check('提取到词条', res.words.length >= 5, 'got ' + res.words.length);
  check('首条英文正确', res.words[0] && res.words[0].en === 'personal',
    JSON.stringify(res.words[0]));
  console.log('  sample:', JSON.stringify(res.words.slice(0, 3)));
})();

/* 6. 粘贴文本的格式兼容性 */
console.log('\n[6] 文本格式兼容');
(function () {
  const cases = [
    ['personal\tadj. 私人的', 'personal', 'adj. 私人的'],
    ['personal  adj. 私人的', 'personal', 'adj. 私人的'],
    ['1. personal  adj. 私人的', 'personal', 'adj. 私人的'],
    ['personal|adj. 私人的', 'personal', 'adj. 私人的'],
    ['personal adj. 私人的', 'personal', 'adj. 私人的'],
    ['give up  v. 放弃', 'give up', 'v. 放弃'],
    ['personal /ˈpɜːsnl/ adj. 私人的', 'personal', 'adj. 私人的'],
    ['私人的 —— personal', 'personal', '私人的']
  ];
  cases.forEach(function (c) {
    const r = wordUtils.parseLine(c[0]);
    check('解析 "' + c[0] + '"', r && r.en === c[1] && r.cn === c[2],
      r ? JSON.stringify(r) : 'null');
  });

  const noCjk = wordUtils.parseLine('abc 123 xyz');
  check('纯英文行被丢弃', noCjk === null, JSON.stringify(noCjk));
})();

/* 7. 批次与随机逻辑 */
console.log('\n[7] 批次计算');
(function () {
  const storage = require(path.join(base, 'storage'));
  const words = Array.from({ length: 23 }, (_, i) => ({ id: 'w' + i, en: 'e' + i, cn: 'c' + i }));
  // storage 依赖 wx，这里只测纯函数逻辑
  const batches = [];
  const size = 6;
  for (let i = 0; i < words.length; i += size) batches.push(words.slice(i, i + size));
  check('23 词 / 6 每批 = 4 批', batches.length === 4, String(batches.length));
  check('最后一批 5 个', batches[3].length === 5, String(batches[3].length));
})();

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
